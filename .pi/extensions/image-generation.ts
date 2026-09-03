import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_PROMPT_LENGTH = 4_000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_STREAM_BYTES = 40 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 360_000;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

type GeneratedImage = {
	data: string;
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	bytes: number;
	width?: number;
	height?: number;
};

function responseEndpoint(baseUrl: string): string {
	const parsed = new URL(baseUrl);
	if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) throw new Error("The configured image provider URL is not supported.");
	parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/responses`;
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString();
}

function providerError(status: number): Error {
	if (status === 401 || status === 403) return new Error("Image generation authentication failed.");
	if (status === 429) return new Error("The image provider is busy or rate limited. Try again later.");
	if (status >= 500) return new Error("The image provider is temporarily unavailable.");
	return new Error(`The image provider rejected the request (${status}).`);
}

function imageFromEvent(event: Record<string, unknown>): string | undefined {
	if (event.type === "response.image_generation_call.partial_image" && typeof event.partial_image_b64 === "string") {
		return event.partial_image_b64;
	}

	if (event.type === "response.output_item.done") {
		const item = event.item;
		if (item && typeof item === "object" && "type" in item && item.type === "image_generation_call" && "result" in item && typeof item.result === "string") {
			return item.result;
		}
	}

	if (event.type === "response.completed") {
		const response = event.response;
		if (response && typeof response === "object" && "output" in response && Array.isArray(response.output)) {
			for (const item of response.output) {
				if (item && typeof item === "object" && item.type === "image_generation_call" && typeof item.result === "string") {
					return item.result;
				}
			}
		}
	}

	return undefined;
}

function processEventBlock(block: string): string | undefined {
	const payload = block
		.split(/\r?\n/u)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
		.trim();
	if (!payload || payload === "[DONE]") return undefined;

	let event: unknown;
	try {
		event = JSON.parse(payload);
	} catch {
		throw new Error("The image provider returned an invalid event stream.");
	}
	return event && typeof event === "object" ? imageFromEvent(event as Record<string, unknown>) : undefined;
}

async function imageFromStream(response: Response): Promise<string> {
	if (!response.body) throw new Error("The image provider returned an empty response.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let received = 0;
	let latestImage = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > MAX_STREAM_BYTES) {
			await reader.cancel();
			throw new Error("The image provider response exceeded the size limit.");
		}
		buffer += decoder.decode(value, { stream: true });

		while (true) {
			const separator = /\r?\n\r?\n/u.exec(buffer);
			if (!separator || separator.index === undefined) break;
			const block = buffer.slice(0, separator.index);
			buffer = buffer.slice(separator.index + separator[0].length);
			const image = processEventBlock(block);
			if (image) latestImage = image;
		}
	}

	buffer += decoder.decode();
	if (buffer.trim()) {
		const image = processEventBlock(buffer);
		if (image) latestImage = image;
	}
	if (!latestImage) throw new Error("The image provider completed without an image.");
	return latestImage;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
	if (bytes.length < 24) return undefined;
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function validateImage(data: string): GeneratedImage {
	const maximumBase64Length = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4;
	if (!data || data.length > maximumBase64Length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) {
		throw new Error("The image provider returned invalid image data.");
	}

	const bytes = Buffer.from(data, "base64");
	if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("The generated image exceeded the size limit.");

	if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return { data, mimeType: "image/png", bytes: bytes.length, ...pngDimensions(bytes) };
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return { data, mimeType: "image/jpeg", bytes: bytes.length };
	}
	if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
		return { data, mimeType: "image/webp", bytes: bytes.length };
	}
	throw new Error("The image provider returned an unsupported image format.");
}

const generateImageTool = defineTool({
	name: "generate_image",
	label: "Generate image",
	description: "Generate one image from a detailed visual description and return it directly in the conversation. Use this when the user asks to create, draw, render, or generate an image.",
	promptSnippet: "Generate an image from a visual description and display it in the conversation",
	promptGuidelines: [
		"Use generate_image when the user explicitly asks to create or generate an image.",
		"Write a self-contained visual prompt, preserving the user's requested subject, style, composition, and constraints.",
	],
	parameters: Type.Object({
		prompt: Type.String({
			description: "A self-contained description of the image to generate. Include subject, style, composition, lighting, and important exclusions.",
			minLength: 1,
			maxLength: MAX_PROMPT_LENGTH,
		}),
	}),
	executionMode: "sequential",

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const prompt = params.prompt.trim();
		if (!prompt || prompt.length > MAX_PROMPT_LENGTH) throw new Error("The image prompt must be between 1 and 4,000 characters.");
		if (!ctx.model) throw new Error("No active model is available for image generation.");
		if (ctx.model.api !== "openai-responses") throw new Error("The active model does not use a compatible image generation API.");

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) throw new Error("Image generation credentials are not available.");
		const baseUrl = auth.baseUrl || ctx.model.baseUrl;
		if (!baseUrl) throw new Error("The image provider URL is not configured.");

		const headers = new Headers(auth.headers);
		headers.set("Accept", "text/event-stream");
		headers.set("Content-Type", "application/json");
		if (auth.apiKey && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${auth.apiKey}`);

		onUpdate?.({
			content: [{ type: "text", text: "Generating the image…" }],
			details: { stage: "generating" },
		});

		const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		let response: Response;
		try {
			response = await fetch(responseEndpoint(baseUrl), {
				method: "POST",
				headers,
				signal: requestSignal,
				body: JSON.stringify({
					model: ctx.model.id,
					store: false,
					stream: true,
					input: [{
						role: "user",
						content: [{
							type: "input_text",
							text: `Create exactly one image from this description. Return the generated image rather than a text-only description.\n\n${prompt}`,
						}],
					}],
					tools: [{ type: "image_generation", partial_images: 0 }],
				}),
			});
		} catch (error) {
			if (signal?.aborted) throw new Error("Image generation was cancelled.");
			if (timeoutSignal.aborted) throw new Error("Image generation timed out.");
			throw new Error("Could not connect to the image provider.", { cause: error });
		}

		if (!response.ok) {
			await response.body?.cancel();
			throw providerError(response.status);
		}
		const contentType = response.headers.get("content-type") || "";
		if (!contentType.toLowerCase().includes("text/event-stream")) {
			await response.body?.cancel();
			throw new Error("The image provider returned an unsupported response type.");
		}

		let imageData: string;
		try {
			imageData = await imageFromStream(response);
		} catch (error) {
			if (signal?.aborted) throw new Error("Image generation was cancelled.");
			if (timeoutSignal.aborted) throw new Error("Image generation timed out.");
			throw error;
		}
		const image = validateImage(imageData);
		return {
			content: [
				{ type: "text", text: "Generated image" },
				{ type: "image", data: image.data, mimeType: image.mimeType },
			],
			details: {
				bytes: image.bytes,
				mimeType: image.mimeType,
				...(image.width && image.height ? { width: image.width, height: image.height } : {}),
			},
		};
	},
});

export default function imageGenerationExtension(pi: ExtensionAPI) {
	pi.registerTool(generateImageTool);
}
