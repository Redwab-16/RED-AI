import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn("GEMINI_API_KEY is not set. AI features will not work.");
}

const ai = new GoogleGenAI({ apiKey: apiKey || "" });

export interface ChatMessage {
  role: "user" | "model";
  content: string;
  type?: "text" | "image";
  timestamp?: number;
}

export async function sendMessage(message: string, history: ChatMessage[] = []) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing. Please add it to your secrets.");
  }

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [
        ...history.map(msg => ({
          role: msg.role,
          parts: [{ text: msg.content }]
        })),
        { role: "user", parts: [{ text: message }] }
      ],
      config: {
        systemInstruction: "You are a helpful, friendly, and intelligent AI assistant powered by Google Gemini. You provide clear, concise, and accurate answers. Use markdown for formatting when appropriate.",
      }
    });

    return response.text || "I'm sorry, I couldn't generate a response.";
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    throw error;
  }
}

export async function* sendMessageStream(message: string, history: ChatMessage[] = []) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing. Please add it to your secrets.");
  }

  try {
    const stream = await ai.models.generateContentStream({
      model: "gemini-3-flash-preview",
      contents: [
        ...history.map(msg => ({
          role: msg.role,
          parts: [{ text: msg.content }]
        })),
        { role: "user", parts: [{ text: message }] }
      ],
      config: {
        systemInstruction: "You are a helpful, friendly, and intelligent AI assistant powered by Google Gemini. You provide clear, concise, and accurate answers. Use markdown for formatting when appropriate.",
      }
    });

    for await (const chunk of stream) {
      if (chunk.text) {
        yield chunk.text;
      }
    }
  } catch (error) {
    console.error("Error in streaming Gemini API:", error);
    throw error;
  }
}

export async function generateImage(prompt: string) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing. Please add it to your secrets.");
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [
          {
            text: prompt,
          },
        ],
      },
      config: {
        imageConfig: {
          aspectRatio: "1:1",
        },
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        const base64EncodeString: string = part.inlineData.data;
        return `data:image/png;base64,${base64EncodeString}`;
      }
    }
    
    throw new Error("No image was generated in the response.");
  } catch (error) {
    console.error("Error generating image:", error);
    throw error;
  }
}
