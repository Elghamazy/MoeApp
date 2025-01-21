import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "../../utils/logger.js";
import { env } from "../../config/env.js";

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);

const personalityPrompt = `
You're a chill, witty WhatsApp bot with a slightly sarcastic sense of humor. Keep responses brief and casual.
Key traits:
- Use humor and light sarcasm when appropriate
- Keep responses short and punchy (1-2 sentences max usually)
- For Arabic, use Egyptian dialect and slang
- Match the language of the user's message
- Feel free to use emojis occasionally, but don't overdo it
- If someone's complaining or feeling down, respond with playful sarcasm like "that's... informative" or "wow, sounds fun"
- Don't be formal or robotic - be conversational

Always respond in this JSON format:
{
  "message": "your response text here",
  "command": null or "command_name",
  "terminate": boolean
}

Examples:
User: "انا مبضون"
{
  "message": "ياه... انت كدة فتحت عيني على الحياة",
  "command": null,
  "terminate": false
}

User: "okay bye"
{
  "message": "Peace out! ✌️",
  "command": null,
  "terminate": true
}

User: "play music"
{
  "message": "Getting those beats ready for you 🎵",
  "command": "play_music",
  "terminate": false
}`;

export async function generateAIResponse(userMessage, chatHistory = []) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // Convert chat history to a formatted string
    const chatPrompt = chatHistory
      .map(entry => `${entry.role === "user" ? "User" : "Bot"}: "${entry.text}"`)
      .join("\n");

    const fullPrompt = {
      text: `
${personalityPrompt}

Previous conversation:
${chatPrompt}

User: "${userMessage}"

Respond with a JSON object following the format above. Set terminate to true if the user wants to end the chat.
Include a command if one is mentioned (e.g., play_music, set_reminder, show_help).`,
      generationConfig: {
        temperature: 0.7,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 200,
      },
      safetySettings: [
        {
          category: "HARM_CATEGORY_HARASSMENT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        },
        {
          category: "HARM_CATEGORY_HATE_SPEECH",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        },
        {
          category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        },
        {
          category: "HARM_CATEGORY_DANGEROUS_CONTENT",
          threshold: "BLOCK_MEDIUM_AND_ABOVE"
        }
      ]
    };

    const result = await model.generateContent(fullPrompt);
    const responseText = result.response.text().trim();
    
    try {
      // Parse the response into the defined schema
      const parsedResponse = JSON.parse(responseText);
      
      // Validate and ensure all required fields are present
      return {
        message: parsedResponse.message || "I'm not sure what you meant 😕",
        command: parsedResponse.command || null,
        terminate: Boolean(parsedResponse.terminate)
      };
    } catch (parseError) {
      logger.error("Response parsing error:", parseError);
      // Fallback response if parsing fails
      return {
        message: responseText.slice(0, 100), // Use first 100 chars of raw response
        command: null,
        terminate: false
      };
    }
  } catch (error) {
    logger.error("AI generation error:", error);
    return { 
      message: "Even AI gets tongue-tied sometimes 🤐", 
      command: null, 
      terminate: false 
    };
  }
}
