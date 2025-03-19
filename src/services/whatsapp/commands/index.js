import { textToSpeech } from "../../audio/tts.js";
import {
  ShutupUsers,
  Commands,
  Settings,
  StoryTracking,
} from "../../../config/database.js";
import { logger } from "../../../utils/logger.js";
import gis from "async-g-i-s";
import https from "https";
import axios from "axios";
import WhatsAppWeb from "whatsapp-web.js";

const { MessageMedia } = WhatsAppWeb;

const SONG_SELECTION_TIMEOUT = 60000; // 60 seconds timeout for selection
const sentImageCache = new Map();
const IMAGE_CACHE_CONFIG = {
  MAX_SIZE: 1000,
  MAX_RETRIES: 3,
  EXPIRY: 24 * 60 * 60 * 1000, // 24 hours in milliseconds
};

function formatSearchResults(results) {
  let message = "*🎵 Found these songs:*\n\n";
  results.forEach((track, index) => {
    message += `*${index + 1}.* ${track.title}\n👤 ${track.artist}\n💿 ${track.album}\n\n`;
  });
  message +=
    "\n_Reply with the number of the song you want to download (1-" +
    results.length +
    ")_";
  return message;
}

async function isAdmin(message) {
  const adminNumbers = process.env.ADMIN?.split(",") || [];

  const contact = await message.getContact();
  const contactNumber = contact?.number || "";

  return adminNumbers.includes(contactNumber);
}

async function getSongDetails(url) {
  try {
    const response = await axios.get(
      "https://elghamazy-moeify.hf.space/getSong",
      {
        params: { url },
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 30000, // 30-second timeout
      },
    );

    const { title, artist, album, cover, urls } = response.data;

    if (!title || !artist || !album || !urls) {
      throw new Error("Invalid response format from API");
    }

    return {
      title,
      artist,
      album,
      cover,
      urls,
    };
  } catch (error) {
    logger.error({ err: error }, "Error fetching song details", {
      url,
      errorResponse: error.response?.data,
      errorStatus: error.response?.status,
    });
    throw new Error("Failed to fetch song details. Please try again later.");
  }
}

async function processSongDownload(message, trackData) {
  const chat = await message.getChat();

  try {
    await chat.sendStateRecording();

    // Request track details from the API
    const response = await axios.get(
      "https://elghamazy-moeify.hf.space/getSong",
      {
        params: { url: trackData.urls.spotifyUrl },
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 30000, // 30-second timeout
      },
    );

    // Destructure the expected properties from the API response
    const { title, artist, album, cover, urls } = response.data;
    if (!title || !artist || !album || !urls) {
      throw new Error("Invalid response format");
    }

    // Create a caption with the track details
    const caption = `🎵 *${title}*\n👤 ${artist}\n💿 ${album}`;

    // Download the audio file from the URL returned by the API.
    // (This URL must point to a direct MP3 file.)
    const audioResponse = await axios.get(urls.downloadUrl, {
      responseType: "arraybuffer",
      timeout: 60000, // 60-second timeout for download
      headers: { Accept: "audio/mpeg" },
      maxContentLength: 50 * 1024 * 1024,
    });

    // Verify that the returned content is audio by checking its Content-Type header
    const contentType = audioResponse.headers["content-type"];
    if (!contentType || !contentType.includes("audio")) {
      throw new Error(
        `Downloaded content is not audio. Content-Type received: ${contentType}`,
      );
    }

    // Convert the downloaded audio data to a base64-encoded string
    const base64Audio = Buffer.from(audioResponse.data).toString("base64");

    // Create a MessageMedia instance for WhatsApp using the downloaded audio data
    const media = new MessageMedia(
      "audio/mpeg",
      base64Audio,
      `${artist} - ${title}.mp3`,
    );

    // Send the audio message with the track caption
    await message.reply(media, null, {
      caption: caption,
      sendAudioAsVoice: false,
    });
  } catch (error) {
    logger.error(error, "Error downloading song", {
      trackUrl: trackData.urls.downloadUrl,
      trackTitle: trackData.title,
    });
    throw error;
  } finally {
    await chat.clearState();
  }
}

async function notifyAndDownloadSong(message, songData) {
  // Notify the user and process the download.
  const { title, artist } = songData;
  await message.reply(
    `*Now downloading:*\n*Title:* ${title}\n*Artist:* ${artist}`,
  );
  await processSongDownload(message, songData);
}

async function waitForSongSelection(message, resultsMessage, results) {
  // Wait for the user to reply with a valid song selection.
  return new Promise((resolve, reject) => {
    const handler = async (reply) => {
      try {
        if (!reply.hasQuotedMsg) return;
        const quotedMessage = await reply.getQuotedMessage();
        if (
          quotedMessage.id._serialized !== resultsMessage.id._serialized ||
          reply.author !== message.author
        ) {
          return;
        }
        const selection = parseInt(reply.body);
        if (!isNaN(selection) && selection > 0 && selection <= results.length) {
          message.client.removeListener("message", handler);
          resolve(results[selection - 1]);
        }
      } catch (error) {
        logger.error(error, "Error handling reply");
      }
    };

    message.client.on("message", handler);

    setTimeout(() => {
      message.client.removeListener("message", handler);
      reject(new Error("Selection timed out"));
    }, SONG_SELECTION_TIMEOUT);
  });
}

async function addShutupUser(message, args) {
  let targetContact;
  const name = args.slice(1).join(" ").replace(/"/g, "");
  const number = args[0].replace(/[^0-9]/g, "");

  if (number.length > 0) {
    targetContact = await message.client.getContactById(`${number}@c.us`);
  } else {
    await message.reply("Please mention a user or provide their number.");
    return;
  }

  const phoneNumber = targetContact.number;

  // Add the user to the shutup list
  await ShutupUsers.upsert(
    { phoneNumber },
    {
      $set: {
        name,
        addedAt: new Date(),
      },
    },
  );

  await message.reply(`Added ${name} (${phoneNumber}) to the shutup list.`);
}

async function removeShutupUser(message, args) {
  let targetContact;
  const number = args[0].replace(/[^0-9]/g, "");

  if (number.length > 0) {
    targetContact = await message.client.getContactById(`${number}@c.us`);
  } else {
    await message.reply("Please mention a user or provide their number.");
    return;
  }

  const phoneNumber = targetContact.number;

  // Remove the user from the shutup list
  const result = await ShutupUsers.deleteOne({ phoneNumber });

  if (result.deletedCount > 0) {
    await message.reply(
      `Removed user with phone number ${phoneNumber} from the shutup list.`,
    );
  } else {
    await message.reply(
      `User with phone number ${phoneNumber} is not in the shutup list.`,
    );
  }
}

export const commandHandlers = {
  async help(message) {
    const commands = await Commands.find({ enabled: true });
    const isUserAdmin = await isAdmin(message);

    // Group commands by category
    const categorizedCommands = commands.reduce((acc, cmd) => {
      if (!cmd.adminOnly || isUserAdmin) {
        if (!acc[cmd.category]) {
          acc[cmd.category] = [];
        }
        acc[cmd.category].push(cmd);
      }
      return acc;
    }, {});

    let response = `📱 *MoeApp Commands*\n\n`;

    for (const [category, cmds] of Object.entries(categorizedCommands)) {
      response += `🔹 *${category.toUpperCase()}*\n`;
      response += `━━━━━━━━━━━━━━━━━━\n`;
      for (const cmd of cmds) {
        response += `\n✨ *Command:* \`!${cmd.name}\`\n`;
        response += `📄 *Description:* ${cmd.description}\n`;
        response += `⚙️ *Usage:* \`${cmd.usage}\`\n`;
        response += `━━━━━━━━━━━━━━━━━━\n`;
      }
      response += `\n`;
    }

    await message.reply(response);
  },
  async toggleai(message) {
    if (!(await isAdmin(message))) {
      await message.reply("This command is for admins only.");
      return;
    }

    const aiSetting = await Settings.findOne({ key: "ai_enabled" });
    const newValue = !aiSetting?.value;

    if (aiSetting) {
      await Settings.updateOne(
        { key: "ai_enabled" },
        {
          $set: {
            value: newValue,
            updatedAt: new Date(),
          },
        },
      );
    } else {
      await Settings.insertOne({
        key: "ai_enabled",
        value: newValue,
        updatedAt: new Date(),
      });
    }

    await message.reply(
      `AI responses are now ${newValue ? "enabled" : "disabled"}`,
    );
  },

  async togglecmd(message, args) {
    if (!(await isAdmin(message))) {
      await message.reply("This command is for admins only.");
      return;
    }

    const cmdName = args[0];
    if (!cmdName) {
      await message.reply("Please specify a command to toggle.");
      return;
    }

    const command = await Commands.findOne({ name: cmdName });
    if (!command) {
      await message.reply("Command not found.");
      return;
    }

    await Commands.updateOne(
      { name: cmdName },
      { $set: { enabled: !command.enabled } },
    );

    await message.reply(
      `Command !${cmdName} is now ${!command.enabled ? "enabled" : "disabled"}`,
    );
  },

  async pfp(message) {
    try {
      let targetContact;

      // Extract numbers from the message body
      const number = message.body.replace(/[^0-9]/g, "");

      if (!number) {
        targetContact = await message.getContact();
      } else if (number.length > 0) {
        targetContact = await message.client.getContactById(`${number}@c.us`);
      } else {
        await message.reply("Please mention a user or provide their number.");
        return;
      }

      const profilePic = await targetContact.getProfilePicUrl();
      if (!profilePic) {
        await message.reply("No profile picture found.");
        return;
      }

      const media = await MessageMedia.fromUrl(profilePic);
      await message.reply(media);
    } catch (error) {
      logger.error({ err: error }, "Error in pfp command:");
      await message.reply("Failed to fetch profile picture.");
    }
  },

  async logs(message) {
    if (!(await isAdmin(message))) {
      await message.reply("This command is for admins only.");
      return;
    }

    const stats = {
      commands: await Commands.find(),
      aiEnabled: (await Settings.findOne({ key: "ai_enabled" }))?.value,
    };

    let report = "📊 *Bot Statistics*\n\n";
    report += `AI Enabled: ${stats.aiEnabled ? "✅" : "❌"}\n\n`;
    report += "*Command Usage:*\n";

    for (const cmd of stats.commands) {
      report += `!${cmd.name}: ${cmd.usageCount} uses`;
      if (cmd.lastUsed) {
        report += ` (Last: ${cmd.lastUsed.toLocaleDateString()})`;
      }
      report += "\n";
    }

    await message.reply(report);
  },
  // Refactored Song Command

  async song(message, args) {
    if (args.length === 0) {
      await message.reply("Please provide a song URL or title.");
      return;
    }

    const query = args.join(" ");
    const chat = await message.getChat();
    let resultsMessage = null;

    try {
      await chat.sendStateTyping();

      // Process Spotify URL directly.
      if (query.includes("spotify.com/track/")) {
        const songData = await getSongDetails(query);
        await notifyAndDownloadSong(message, songData);
        return;
      }

      // Search for songs.
      const searchResponse = await axios.get(
        "https://elghamazy-moeify.hf.space/search",
        {
          params: { query },
        },
      );

      if (
        !searchResponse.data.results ||
        searchResponse.data.results.length === 0
      ) {
        await message.reply("No songs found matching your query.");
        return;
      }

      const results = searchResponse.data.results;

      // If only one result, auto-download.
      if (results.length === 1) {
        const songData = await getSongDetails(results[0].url);
        await notifyAndDownloadSong(message, songData);
        return;
      }

      // Multiple results: send selection message.
      resultsMessage = await message.reply(formatSearchResults(results));

      // Wait for user selection.
      const selectedTrack = await waitForSongSelection(
        message,
        resultsMessage,
        results,
      );

      // Fetch song details and download.
      await resultsMessage.edit("*⏳ Fetching song details...*");
      const songData = await getSongDetails(selectedTrack.url);
      await resultsMessage.edit("*⏬ Downloading song...*");
      await notifyAndDownloadSong(message, songData);
      await resultsMessage.edit(
        `*✅ Download Completed!*\n\n*Title:* ${songData.title}\n*Artist:* ${songData.artist}\n\nEnjoy your music!`,
      );
    } catch (error) {
      if (resultsMessage) {
        if (error.message === "Selection timed out") {
          await resultsMessage.edit(
            "❌ Song selection timed out. Please try again.",
          );
          return;
        } else {
          await resultsMessage.edit(
            "❌ Failed to process your request. Please try again.",
          );
        }
      }
      logger.error(error, "Error in song command", {
        query,
        errorResponse: error.response?.data,
        errorStatus: error.response?.status,
      });
      if (!resultsMessage) {
        let errorMessage = "Failed to process the song request.";
        if (error.response) {
          switch (error.response.status) {
            case 404:
              errorMessage =
                "Song not found. Please check your query and try again.";
              break;
            case 429:
              errorMessage = "Too many requests. Please try again later.";
              break;
            case 400:
              errorMessage =
                "Invalid request. Please try a different song or URL.";
              break;
            case 500:
              errorMessage = "Server error. Please try again later.";
              break;
          }
        }
        await message.reply(errorMessage);
      }
    } finally {
      await chat.clearState();
    }
  },
  async track(message, args) {
    try {
      let targetNumber;

      // Handle no arguments
      if (args.length === 0) {
        await message.reply(
          "Usage: !track <number/mention>\nOr: !track list\nOr: !track stop <number/mention>",
        );
        return;
      }

      // Get tracker's contact info
      const trackerContact = await message.getContact();
      const trackerNumber = `${trackerContact.number}@c.us`;

      // Handle subcommands
      if (args[0].toLowerCase() === "list") {
        const trackingList = await StoryTracking.find({
          trackerNumber,
          active: true,
        });

        if (trackingList.length === 0) {
          await message.reply("You are not tracking any numbers.");
          return;
        }

        let response = "*Currently tracking:*\n\n";
        for (const track of trackingList) {
          const contact = await message.client.getContactById(
            track.targetNumber,
          );
          response += `📱 ${contact.pushname || "Unknown"} (${track.targetNumber.split("@")[0]})\n`;
        }
        await message.reply(response);
        return;
      }

      if (args[0].toLowerCase() === "stop") {
        if (args.length < 2) {
          await message.reply(
            "Please specify a number/mention to stop tracking.",
          );
          return;
        }

        // Get target number
        if (message.mentionedIds.length > 0) {
          targetNumber = message.mentionedIds[0];
        } else {
          const number = args[1].replace(/[^0-9]/g, "");
          targetNumber = `${number}@c.us`;
        }

        // Stop tracking
        const result = await StoryTracking.updateOne(
          {
            targetNumber,
            trackerNumber,
            active: true,
          },
          {
            $set: { active: false },
          },
        );

        if (result.modifiedCount > 0) {
          await message.reply("Successfully stopped tracking stories.");
        } else {
          await message.reply("You were not tracking this number.");
        }
        return;
      }

      // Handle tracking new number
      if (message.mentionedIds.length > 0) {
        targetNumber = message.mentionedIds[0];
      } else {
        const number = args[0].replace(/[^0-9]/g, "");
        targetNumber = `${number}@c.us`;
      }

      // Verify the target number exists
      try {
        const targetContact = await message.client.getContactById(targetNumber);
        if (!targetContact) {
          await message.reply("Invalid number provided.");
          return;
        }
      } catch (error) {
        await message.reply("Could not find a contact with that number.");
        return;
      }

      // Check if already tracking
      const existing = await StoryTracking.findOne({
        targetNumber,
        trackerNumber,
        active: true,
      });

      if (existing) {
        await message.reply("You are already tracking this number's stories.");
        return;
      }

      // Add new tracking entry
      await StoryTracking.insertOne({
        targetNumber,
        trackerNumber,
        lastChecked: new Date(),
        active: true,
        addedAt: new Date(),
      });

      await message.reply(
        "Successfully started tracking stories.\nYou will receive new stories in your DMs.",
      );
    } catch (error) {
      logger.error({ err: error }, "Error in track command:");
      await message.reply("An error occurred while setting up story tracking.");
    }
  },

  async redgifs(message, args) {
    // Check if correct number of arguments is provided
    if (args.length !== 2) {
      await message.reply(
        "Usage: !redgifs <number> <password>\nNumber must be between 1 and 20.",
      );
      return;
    }

    const [number, password] = args;

    // Validate password (you should replace this with your desired password)
    const CORRECT_PASSWORD = "moedaily"; // Replace with your actual password
    if (password !== CORRECT_PASSWORD) {
      await message.reply("Invalid password.");
      return;
    }

    // Validate number is a positive integer and doesn't exceed 20
    const numberValue = parseInt(number);
    if (isNaN(numberValue) || numberValue <= 0) {
      await message.reply("Please provide a valid positive number.");
      return;
    }

    // Add the new check for maximum value
    if (numberValue > 20) {
      await message.reply("Number cannot exceed 20.");
      return;
    }

    try {
      const contact = await message.getContact();
      const chat = await message.getChat();

      // Show typing indicator
      await chat.sendStateTyping();

      // Make the POST request
      const response = await axios.post(
        "https://elghamazy-moedaily.hf.space/generate",
        {
          number: numberValue,
          phoneNumber: `${contact.number}@c.us`,
        },
        {
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      // Clear typing state
      await chat.clearState();

      // Send confirmation message
      await message.reply(
        "The media has been sent to you in private! enjoy 🎉",
      );
    } catch (error) {
      logger.error({ err: error }, "Error in redgifs command:");
      await message.reply(
        "An error occurred while processing your request. Please try again later.",
      );
    }
  },

  async speak(message) {
    if (!message.hasQuotedMsg) {
      await message.reply("Please quote a message to convert to speech.");
      return;
    }
    const chat = await message.getChat();

    try {
      const quotedMessage = await message.getQuotedMessage();
      const { base64, mimeType } = await textToSpeech(quotedMessage.body);
      const media = new MessageMedia(mimeType, base64);

      await quotedMessage.reply(media, chat.id._serialized, {
        sendAudioAsVoice: true,
      });
    } catch (error) {
      logger.error({ err: error }, "Error in speak command:");
      await message.reply("Failed to convert text to speech.");
    }
  },

  async img(message, args) {
    // Helper function to clean expired cache entries
    const cleanExpiredCache = () => {
      const currentTime = Date.now();
      for (const [query, data] of sentImageCache.entries()) {
        if (currentTime - data.timestamp > IMAGE_CACHE_CONFIG.EXPIRY) {
          sentImageCache.delete(query);
        }
      }
    };

    // Helper function to extract image count
    const extractImageCount = (message) => {
      const cleanMessage = message.replace(/^!image\s+/, "").trim();
      const match = cleanMessage.match(/\[(\d+)\]/);

      if (match) {
        const count = Math.min(Math.max(1, parseInt(match[1])), 10);
        const query = cleanMessage.replace(/\[\d+\]/, "").trim();
        return { count, query };
      }

      return { count: 1, query: cleanMessage };
    };

    // Helper function to validate image URL
    const isValidImageUrl = async (url, retryCount = 0) => {
      try {
        const response = await axios.head(url, {
          timeout: 5000,
          validateStatus: (status) => status === 200,
        });

        return response.headers["content-type"]?.startsWith("image/");
      } catch (error) {
        if (retryCount < IMAGE_CACHE_CONFIG.MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return isValidImageUrl(url, retryCount + 1);
        }
        return false;
      }
    };

    // Helper function to get unique images
    const getUniqueImages = async (query, count, results) => {
      const currentTime = Date.now();

      // Clean expired cache entries
      cleanExpiredCache();

      // Get or create cache entry for this query
      const cacheEntry = sentImageCache.get(query) || {
        urls: new Set(),
        timestamp: currentTime,
      };

      const uniqueImages = [];
      const seenUrls = new Set();

      // Shuffle the results array to get random images
      const shuffledResults = results.sort(() => Math.random() - 0.5);

      for (const result of shuffledResults) {
        if (uniqueImages.length >= count) break;

        const url = result.url;

        // Skip if URL was seen in this session or exists in cache
        if (seenUrls.has(url) || cacheEntry.urls.has(url)) {
          continue;
        }

        seenUrls.add(url);

        try {
          const isValid = await isValidImageUrl(url);
          if (isValid) {
            uniqueImages.push(result);
            cacheEntry.urls.add(url);
          }
        } catch (error) {
          logger.error(`Error validating image URL ${url}:`, error.message);
          continue;
        }
      }

      // Update cache timestamp
      cacheEntry.timestamp = currentTime;

      // Manage cache size
      if (cacheEntry.urls.size > IMAGE_CACHE_CONFIG.MAX_SIZE) {
        // Convert to array, sort by age, and keep newest half
        const urlArray = Array.from(cacheEntry.urls);
        cacheEntry.urls = new Set(
          urlArray.slice(-IMAGE_CACHE_CONFIG.MAX_SIZE / 2),
        );
      }

      // Update cache
      sentImageCache.set(query, cacheEntry);

      return uniqueImages;
    };

    // Helper function to fetch and prepare images
    const fetchAndPrepareImages = async (images) => {
      return Promise.all(
        images.map(async (image) => {
          let retryCount = 0;
          while (retryCount < IMAGE_CACHE_CONFIG.MAX_RETRIES) {
            try {
              const response = await axios.get(image.url, {
                responseType: "arraybuffer",
                timeout: 10000,
                maxContentLength: 5 * 1024 * 1024, // 5MB max size
              });

              const contentType = response.headers["content-type"];
              if (!contentType?.startsWith("image/")) {
                throw new Error("Invalid content type: " + contentType);
              }

              return new MessageMedia(
                contentType,
                Buffer.from(response.data).toString("base64"),
                `image.${contentType.split("/")[1]}`,
              );
            } catch (error) {
              retryCount++;
              if (retryCount >= IMAGE_CACHE_CONFIG.MAX_RETRIES) {
                console.error(
                  `Failed to fetch image after ${IMAGE_CACHE_CONFIG.MAX_RETRIES} attempts:`,
                  error.message,
                );
                throw error;
              }
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }),
      );
    };

    try {
      if (args.length === 0) {
        await message.reply("Please provide a search query.");
        return;
      }

      const { count, query } = extractImageCount(args.join(" "));
      const results = await gis(query);

      if (!results || results.length === 0) {
        await message.reply("No images found.");
        return;
      }

      const uniqueImages = await getUniqueImages(query, count, results);

      if (uniqueImages.length === 0) {
        await message.reply(
          "No new unique images found. Try a different search term.",
        );
        return;
      }

      // Fetch and prepare images
      const mediaImages = await fetchAndPrepareImages(uniqueImages);

      // Send images
      for (const media of mediaImages) {
        try {
          await message.reply(media);
        } catch (sendError) {
          logger.error({ err: sendError }, "Error sending image:");
          // Continue to next image if one fails
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Error in img command:");
      await message.reply("Failed to search for images.");
    }
  },

  async msg(message, args) {
    if (!(await isAdmin(message))) {
      await message.reply("This command is for admins only.");
      return;
    }

    if (args.length < 2) {
      await message.reply("Usage: !msg <number/mention> <message>");
      return;
    }

    try {
      let targetNumber;
      if (message.mentionedIds.length > 0) {
        targetNumber = message.mentionedIds[0];
      } else {
        // Extract the number from the args until a non-numeric argument is found
        const numberParts = [];
        while (
          args.length > 0 &&
          /^[0-9]+$/.test(args[0].replace(/[^0-9]/g, ""))
        ) {
          numberParts.push(args.shift().replace(/[^0-9]/g, ""));
        }
        targetNumber = `${numberParts.join("")}@c.us`;
      }

      const messageText = args.join(" ");
      await message.client.sendMessage(targetNumber, messageText);
      await message.reply("Message sent successfully.");
    } catch (error) {
      logger.error({ err: error }, "Error in msg command:");
      await message.reply("Failed to send message.");
    }
  },
  async shutup(message, args) {
    if (!(await isAdmin(message))) {
      await message.reply("This command is for admins only.");
      return;
    }

    if (args.length < 2) {
      await message.reply(
        'Usage: !shutup <mention or phone number> "<name of the person>"\n' +
          "or !shutup remove <mention or phone number>",
      );
      return;
    }

    const action = args[0].toLowerCase();

    if (action === "remove") {
      await removeShutupUser(message, args.slice(1));
    } else {
      await addShutupUser(message, args);
    }
  },
};
