import type { AnalysisReport } from "@/lib/analysis-types";
import { SYSTEM_PROMPT } from "@/lib/analysis-prompt";

/**
 * Gemini vision models, tried in order. Override with the GEMINI_MODEL env var.
 * If one is unavailable for the key, the next is tried automatically.
 */
const GEMINI_MODELS = [
  process.env["GEMINI_MODEL"]?.trim(),
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
].filter(Boolean) as string[];

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

const GATEWAY_MODEL = "google/gemini-3.7-flash";
const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

export type AnalyzeRequest = { imageDataUrl: string; note?: string | undefined };

export class AnalysisError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

function assertDataUrl(dataUrl: string) {
  if (!/^data:[^;,]+;base64,.+$/i.test(dataUrl.trim())) {
    throw new AnalysisError("Please upload a valid image file.", 400);
  }
}

function extractReport(raw: string): AnalysisReport {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned) as AnalysisReport;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as AnalysisReport;
    }
    throw new AnalysisError("The analysis engine returned an unreadable report. Please retry.", 502);
  }
}

function buildUserText(note?: string) {
  return note
    ? `Analyse this sample and return the JSON report. Grower note: ${note}`
    : "Analyse this sample and return the JSON report.";
}

function buildMessages(imageDataUrl: string, note?: string) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: buildUserText(note) },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    },
  ];
}


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A generic OpenAI-compatible vision provider. */
type Provider = {
  name: string;
  url: string;
  apiKey: string;
  models: string[];
  headers: Record<string, string>;
};

/** Builds the ordered provider chain from whichever API keys are configured. */
function buildProviders(): Provider[] {
  const providers: Provider[] = [];
  const env = (name: string) => process.env[name]?.trim();

  const geminiKey = env("GEMINI_API_KEY");
  if (geminiKey) {
    providers.push({
      name: "Gemini",
      url: GEMINI_URL,
      apiKey: geminiKey,
      models: GEMINI_MODELS,
      headers: { Authorization: `Bearer ${geminiKey}` },
    });
  }

  const openaiKey = env("OPENAI_API_KEY");
  if (openaiKey) {
    providers.push({
      name: "OpenAI",
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: openaiKey,
      models: [env("OPENAI_MODEL"), "gpt-4o-mini", "gpt-4o"].filter(Boolean) as string[],
      headers: { Authorization: `Bearer ${openaiKey}` },
    });
  }

  const openrouterKey = env("OPENROUTER_API_KEY");
  if (openrouterKey) {
    providers.push({
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: openrouterKey,
      models: [
        env("OPENROUTER_MODEL"),
        "google/gemini-2.0-flash-001",
        "anthropic/claude-3.5-sonnet",
      ].filter(Boolean) as string[],
      headers: { Authorization: `Bearer ${openrouterKey}` },
    });
  }

  const groqKey = env("GROQ_API_KEY");
  if (groqKey) {
    providers.push({
      name: "Groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      apiKey: groqKey,
      models: [env("GROQ_MODEL"), "meta-llama/llama-4-scout-17b-16e-instruct"].filter(
        Boolean,
      ) as string[],
      headers: { Authorization: `Bearer ${groqKey}` },
    });
  }

  const lovableKey = env("LOVABLE_API_KEY");
  if (lovableKey) {
    providers.push({
      name: "Lovable AI",
      url: GATEWAY_URL,
      apiKey: lovableKey,
      models: [GATEWAY_MODEL],
      headers: { "Lovable-API-Key": lovableKey },
    });
  }

  return providers;
}

async function callModel(
  provider: Provider,
  model: string,
  imageDataUrl: string,
  note?: string,
) {
  return fetch(provider.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...provider.headers,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: buildMessages(imageDataUrl, note),
    }),
  });
}

type ProviderOutcome =
  | { ok: true; report: AnalysisReport }
  | { ok: false; message: string; status: number; fatal: boolean };

/** Tries every model of one provider, with backoff on transient failures. */
async function runProvider(
  provider: Provider,
  imageDataUrl: string,
  note?: string,
): Promise<ProviderOutcome> {
  let lastMessage = "";
  let lastStatus = 502;

  for (const model of provider.models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await callModel(provider, model, imageDataUrl, note);
      } catch (networkError) {
        lastMessage = networkError instanceof Error ? networkError.message : "Network error";
        lastStatus = 503;
        await sleep(600 * (attempt + 1));
        continue;
      }

      if (response.ok) {
        const payload = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const raw = payload.choices?.[0]?.message?.content ?? "";
        if (!raw) {
          lastMessage = "The analysis engine returned an empty report.";
          lastStatus = 502;
          break;
        }
        try {
          return { ok: true, report: extractReport(raw) };
        } catch (parseError) {
          lastMessage =
            parseError instanceof Error ? parseError.message : "Unreadable report returned.";
          lastStatus = 502;
          break;
        }
      }

      const body = await response.text();
      let providerMessage = "";
      try {
        providerMessage =
          (JSON.parse(body) as { error?: { message?: string } }).error?.message?.trim() ?? "";
      } catch {
        providerMessage = body.slice(0, 300);
      }
      console.error(`${provider.name} error`, model, response.status, providerMessage);
      lastMessage = providerMessage;
      lastStatus = response.status;

      // Model unavailable for this key -> next model of the same provider.
      const modelProblem =
        response.status === 404 ||
        /does not exist|do not have access|not found|unsupported model|deprecated|not supported/i.test(
          providerMessage,
        );
      if (modelProblem) break;

      // Bad key or blocked -> this provider is out; the chain continues elsewhere.
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          status: 403,
          fatal: false,
          message: providerMessage || `${provider.name} rejected the configured API key.`,
        };
      }
      if (response.status === 400) {
        // The request itself is wrong — no other provider will accept it either.
        return {
          ok: false,
          status: 400,
          fatal: true,
          message:
            providerMessage || "The request was rejected. Check the image size and format.",
        };
      }
      if (response.status === 402) {
        return {
          ok: false,
          status: 402,
          fatal: false,
          message: providerMessage || `${provider.name} credits are exhausted.`,
        };
      }
      if (response.status === 429 || response.status >= 500) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      break;
    }
  }

  return { ok: false, status: lastStatus, fatal: false, message: lastMessage };
}

/** Runs the vision analysis across every configured provider, in order. */
export async function analyzeWithGemini(input: AnalyzeRequest): Promise<AnalysisReport> {
  const providers = buildProviders();

  if (providers.length === 0) {
    throw new AnalysisError(
      "AI is not configured. Add GEMINI_API_KEY (or OPENAI_API_KEY / OPENROUTER_API_KEY / GROQ_API_KEY) in your host's environment variables, then redeploy.",
      500,
    );
  }

  if (!input?.imageDataUrl || input.imageDataUrl.length < 20) {
    throw new AnalysisError("An image is required.", 400);
  }
  assertDataUrl(input.imageDataUrl);
  const note = typeof input.note === "string" ? input.note.slice(0, 500) : undefined;

  let lastMessage = "";
  let lastStatus = 502;

  for (const provider of providers) {
    const outcome = await runProvider(provider, input.imageDataUrl, note);
    if (outcome.ok) return outcome.report;

    if (outcome.fatal) throw new AnalysisError(outcome.message, outcome.status);

    lastMessage = outcome.message ? `${provider.name}: ${outcome.message}` : lastMessage;
    lastStatus = outcome.status;
    console.error(`Falling back from ${provider.name}`);
  }

  if (lastStatus === 429) {
    throw new AnalysisError(
      lastMessage || "All AI providers are rate limited — please try again shortly.",
      429,
    );
  }
  if (lastStatus === 402) {
    throw new AnalysisError(lastMessage || "AI credits are exhausted. Please top up.", 402);
  }
  throw new AnalysisError(
    lastMessage || "No configured AI provider could analyse this image.",
    lastStatus >= 500 ? 503 : 502,
  );
}

