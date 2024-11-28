import { handleText, state } from '../services/telegram/handlers.js';
import { MessageQueue } from './messageQueue.js';
import xPostCapture from '../services/social/xPostCapture.js';

import { CONFIG } from '../config/index.js';

// Add image cache
const imageCache = new Map();

const maxConsecutiveErrors = CONFIG.BOT.MAX_CONSECUTIVE_ERRORS || 5;
let consecutiveErrors = 0;

// Helper function to get image description
async function getImageDescription(bot, openai, fileId) {
  try {
    // Check cache first
    if (imageCache.has(fileId)) {
      return imageCache.get(fileId);
    }

    // Get file path from Telegram
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;

    // Get description from vision model
    const response = await openai.chat.completions.create({
      model: CONFIG.AI.VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image? Describe it briefly." },
            { type: "image_url", image_url: { url: fileUrl } }
          ],
        },
      ],
      max_tokens: 128,
    });

    const description = response.choices[0].message.content;
    
    // Cache the result
    imageCache.set(fileId, description);
    
    return description;
  } catch (error) {
    console.error('Error getting image description:', error);
    return "Unable to describe image";
  }
}

const messageQueue = new MessageQueue();
let processingInterval;
const MAX_HISTORY_LENGTH = parseInt(process.env.MAX_HISTORY_LENGTH, 10);

// Add circuit breaker state
const circuitBreaker = {
  failures: 0,
  lastFailure: 0,
  isOpen: false,
  timeout: 5 * 60 * 1000, // 5 minutes
  maxFailures: 10
};

// Reset circuit breaker
function resetCircuitBreaker() {
  circuitBreaker.failures = 0;
  circuitBreaker.lastFailure = 0;
  circuitBreaker.isOpen = false;
}

// Check if circuit is open
function isCircuitOpen() {
  if (!circuitBreaker.isOpen) return false;
  
  // Check if timeout has passed
  if (Date.now() - circuitBreaker.lastFailure > circuitBreaker.timeout) {
    resetCircuitBreaker();
    return false;
  }
  return true;
}

export async function setupMessageHandlers(bot, openai) {
  try {
    // Initialize xPostCapture
    await xPostCapture.initialize();
    
    // Start message processing loop
    startMessageProcessing(bot, openai);

    bot.on('message', async (msg) => {
      try {
        const chatId = msg.chat.id;
        
        // Check for X.com status URLs
        if (msg.text && xPostCapture.isXStatusUrl(msg.text)) {
          try {
            const capturedPost = await xPostCapture.capturePost(msg);
            if (capturedPost) {
              console.log('Captured X post:', capturedPost.postId);
              // Optionally acknowledge capture
              // await bot.sendMessage(chatId, '✓ Post captured');
            }
          } catch (error) {
            console.error('Error capturing X post:', error);
          }
        }

        // Continue with existing message handling
        if (msg.photo || msg.text) {
          messageQueue.addMessage(chatId, msg);
          await logMessage(chatId, msg, bot, openai);
        }
      } catch (error) {
        console.error('Error handling message:', error);
      }
    });
  } catch (error) {
    console.error('Error in setupMessageHandlers:', error);
    throw error;
  }
}

// Update logMessage function to handle images
async function logMessage(chatId, msg, bot, openai) {
  const userId = msg.from.id;
  const username = msg.from.username || `${msg.from.first_name} ${msg.from.last_name || ''}`.trim();
  const location = msg.location ? `${msg.location.latitude}, ${msg.location.longitude}` : "Unknown Location";

  let content = [];
  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1];
    const description = await getImageDescription(bot, openai, photo.file_id);
    content.push(
      { type: "text", text: msg.caption || "Shared an image:" },
      { type: "image_description", text: description }
    );
  } else if (msg.text) {
    content.push({ type: "text", text: msg.text });
  }

  // Initialize chat history if needed
  if (!state.chatHistories[chatId]) {
    state.chatHistories[chatId] = [];
  }

  state.chatHistories[chatId].push({
    role: 'user',
    userId,
    username,
    location,
    content,
    timestamp: Date.now()
  });

  if (state.chatHistories[chatId].length > MAX_HISTORY_LENGTH) {
    state.chatHistories[chatId] = state.chatHistories[chatId].slice(-MAX_HISTORY_LENGTH);
  }
}

// Add error handling utilities
const handleError = (error, chatId) => {
  if (error.code === 'ETELEGRAM') {
    if (error.message.includes('409 Conflict')) {
      console.error('409 Conflict: Another bot instance is running. Shutting down.');
      process.exit(1); // Exit the process
    }
    if (error.message.includes('ECONNRESET') || error.message.includes('EFATAL')) {
      console.warn(`Connection error for chat ${chatId}, will retry: ${error.message}`);
      return true; // Should retry
    }
    if (error.message.includes('ETELEGRAM') || error.code === 429) {
      console.warn(`Rate limit hit for chat ${chatId}: ${error.message}`);
      return true; // Should retry
    }
  }
  console.error(`Unhandled error for chat ${chatId}:`, error.message);
  return false; // Don't retry unknown errors
};

// Add jitter to prevent thundering herd
const getBackoffDelay = (retryCount, baseDelay = 1000, maxDelay = 30000) => {
  const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
  return delay + Math.random() * 1000; // Add random jitter
};

// Flag to ensure only one processing loop is active
let isProcessingLoopActive = false;

async function processNextMessage(bot, openai, chatId) {
  if (isCircuitOpen()) {
    console.warn('Circuit breaker is open, skipping message processing');
    return;
  }

  let retryCount = 0;
  const maxRetries = CONFIG.BOT.RECONNECT_ATTEMPTS;
  let lastError = null;

  const attempt = async () => {
    try {
      if (retryCount > 0) {
        // Add increasing delay between retries with jitter
        const delay = getBackoffDelay(retryCount);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      await bot.sendChatAction(chatId, 'typing');
      const response = await handleText(chatId, openai, bot);
      if (!response) return;
      

      if (response.imageUrl) {
        await bot.sendPhoto(chatId, response.imageUrl);
      }
      await bot.sendMessage(chatId, response.text);
      
      // Reset circuit breaker on success
      resetCircuitBreaker();
      return response;

    } catch (error) {
      lastError = error;
      
      if (handleError(error, chatId)) {
        circuitBreaker.failures++;
        circuitBreaker.lastFailure = Date.now();
        
        if (circuitBreaker.failures >= circuitBreaker.maxFailures) {
          circuitBreaker.isOpen = true;
          console.error('Circuit breaker opened due to persistent connection failures');
          return;
        }

        if (retryCount < maxRetries) {
          retryCount++;
          console.warn(`Connection error, attempt ${retryCount}/${maxRetries}`);
          return await attempt();
        }
      }
      
      throw error;
    }
  };

  try {
    await attempt();
  } catch (error) {
    console.error(`Error processing messages for chat ${chatId}: ${error.message}`);
    throw error;
  }
}

function startMessageProcessing(bot, openai) {
  // Prevent multiple processing loops
  if (isProcessingLoopActive) {
    console.warn('Message processing loop is already active.');
    return;
  }

  if (processingInterval) clearTimeout(processingInterval);

  isProcessingLoopActive = true;

  async function process() {
    // Check if the loop has been stopped
    if (!isProcessingLoopActive) {
      console.warn('Message processing loop has been stopped.');
      return;
    }

    if (isCircuitOpen()) {
      console.warn('Circuit breaker is open, skipping processing cycle');
    } else {
      const chats = messageQueue.getAllChats();
      
      for (const chatId of chats) {
        state.lastChecked = state.lastChecked || {};
        state.lastChecked[chatId] = state.lastChecked[chatId] || 0;
        if (state.chatHistories[chatId]?.length > 0 && state.chatHistories[chatId][state.chatHistories[chatId].length - 1].role !== 'assistant') {

          try {
            await processNextMessage(bot, openai, chatId);
            // Reset consecutive errors on success
            consecutiveErrors = 0;
          } catch (error) {
            consecutiveErrors++;
            console.error(`Error processing messages for chat ${chatId}: ${error.message}`);
            if (consecutiveErrors >= maxConsecutiveErrors) {
              console.error('Too many consecutive errors, restarting processing...');
              stopMessageProcessing();
              // Restart processing loop after delay to prevent immediate conflict
              setTimeout(() => startMessageProcessing(bot, openai), 30000);
              return;
            }
          }
        }
      }
    }
    // Schedule the next processing cycle
    processingInterval = setTimeout(process, CONFIG.BOT.POLLING_INTERVAL || 33333); // Delay between cycles
  }
  
  // Start the processing loop
  processingInterval = setTimeout(async () => await process(), 1000); // Initial delay
}

export function stopMessageProcessing() {
  if (processingInterval) {
    clearTimeout(processingInterval);
    processingInterval = null;
    isProcessingLoopActive = false;
    console.warn('Message processing loop has been stopped.');
  }
}