import LiftAi from "../../models/lift-ai.js";
import Price from "../../models/price.js";
import Boom from "boom";
import User from "../../models/user.js";
import Prompts from "../../models/userprompts.js";
import { handleUserInput } from "../bA";

export const chat = async (req, res, next) => {
  try {
    const { message, userId } = req.body;
    if (!userId) {
      return next(Boom.badRequest("userId is required"));
    }

    // Fetch pricing config
    const pricingConfig = await Price.findOne();
    if (!pricingConfig) {
      return next(Boom.internal("Pricing configuration not found"));
    }
    const characterPerToken = pricingConfig.Characterpertoken || 4;
    const finalDiscount = pricingConfig.FinalDiscount || 0;
    const discountMultiplier = 1 - finalDiscount / 100;

    // Estimate tokens for user's message
    const tokensForMessage = Math.ceil(message.length / characterPerToken);
    const discountedTokensForMessage =
      Math.ceil(tokensForMessage * discountMultiplier);

    // Check user's balance
    const userDoc = await User.findById(userId);
    if (!userDoc) {
      return next(Boom.notFound("User not found"));
    }
    if ((userDoc.tokens || 0) < discountedTokensForMessage) {
      return next(Boom.badRequest("Not enough tokens to send message"));
    }

    // Actually handle the AI call
    const reply = await handleUserInput(userId, message);

    // Short‐circuit if it's a file download
    if (typeof reply === "object" && reply.downloadUrl) {
      return res.json({ downloadUrl: reply.downloadUrl });
    }

    // Compute tokens for message + reply
    const totalChars = message.length + reply.length;
    const tokensUsed = Math.ceil(totalChars / characterPerToken);
    const discountedTokens = Math.ceil(tokensUsed * discountMultiplier);

    // === NEW: 15‐minute window logic for Prompts collection ===
    // Find the latest prompt record for this user
    let lastPrompt = await Prompts.findOne({ user: userId })
      .sort({ createdAt: -1 })
      .exec();

    const FIFTEEN_MINUTES = 15 * 60 * 1000;
    const now = Date.now();

    let promptDoc;
    if (!lastPrompt || now - lastPrompt.createdAt.getTime() > FIFTEEN_MINUTES) {
      // Older than 15 min (or none exists) → start a brand new record
      promptDoc = new Prompts({
        user: userId,
        tokens_used: tokensUsed,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    } else {
      // Within 15 min → just increment the existing one
      lastPrompt.tokens_used += tokensUsed;
      lastPrompt.updatedAt = new Date();
      promptDoc = lastPrompt;
    }
    await promptDoc.save();

    // Deduct tokens from the user account
    userDoc.tokens = Math.max(0, (userDoc.tokens || 0) - discountedTokens);
    await userDoc.save();

    return res.json({
      reply,
      tokensUsed,
      totalTokensUsed: promptDoc.tokens_used
    });
  } catch (err) {
    console.error("Chat error:", err);
    return res.status(500).json({ error: "Error processing your request" });
  }
};


// Get LiftAi prompt data. Always fetches from the database.
export const getPrompt = async (req, res, next) => {
  try {
    const liftAiDoc = await LiftAi.findOne();
    if (!liftAiDoc) {
      return next(Boom.notFound("Prompt data not found"));
    }
    return res.status(200).json({ success: true, data: liftAiDoc });
  } catch (error) {
    return next(Boom.internal("Error fetching LiftAi prompt data", error));
  }
};

// PUT /api/lift-ai/prompt
export const updatePrompt = async (req, res, next) => {
  try {
    const { prompt } = req.body;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return next(Boom.badRequest("`prompt` is required and must be a non-empty string."));
    }

    let liftAiDoc = await LiftAi.findOne();
    if (!liftAiDoc) {
      liftAiDoc = new LiftAi({ prompt: prompt.trim() });
    } else {
      liftAiDoc.prompt = prompt.trim();
    }

    await liftAiDoc.save();
    return res.status(200).json({ success: true, data: liftAiDoc });
  } catch (error) {
    return next(Boom.internal("Error updating LiftAi prompt data", error));
  }
};

// Get user tokens for a given user by ID.
const getUserTokens = async (req, res, next) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) {
      return next(Boom.notFound("User not found"));
    }
    return res.status(200).json({ success: true, tokens: user.tokens || 0 });
  } catch (error) {
    console.error("Error fetching user tokens:", error);
    return next(Boom.internal("Error retrieving user tokens", error));
  }
};

// Get all conversation prompts for a given user.
const getAllPrompts = async (req, res, next) => {
  try {
    const prompts = await Prompts.find()
      .populate("user", "username _id") // Populate user field with username and ID
      .lean(); // Convert to plain objects for easier manipulation

    return res.status(200).json({ success: true, data: prompts });
  } catch (error) {
    console.error("Error fetching all prompts:", error);
    return next(Boom.internal("Error retrieving all prompts", error));
  }
};



export default { chat, getPrompt, updatePrompt, getUserTokens, getAllPrompts };
