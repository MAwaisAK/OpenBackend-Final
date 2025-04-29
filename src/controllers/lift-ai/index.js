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

    const reply = await handleUserInput(userId, message);

    // If a document URL was returned, shortcut the response
    if (typeof reply === "object" && reply.downloadUrl) {
      return res.json({ downloadUrl: reply.downloadUrl });
    }

    // Calculate tokens used
   // Fetch pricing configuration from the database
   const pricingConfig = await Price.findOne();
   if (!pricingConfig) {
     return next(Boom.internal("Pricing configuration not found"));
   }

   const characterPerToken = pricingConfig.Characterpertoken || 4; // default fallback
   const finalDiscount = pricingConfig.FinalDiscount || 0;        // default fallback (no discount)
   const discountMultiplier = 1 - finalDiscount / 100;

   // Calculate tokens used
   const totalCharacters = message.length + reply.length;
   const tokensUsedRaw = totalCharacters / characterPerToken;
   const tokensUsed = Math.ceil(tokensUsedRaw);

   // Apply Final Discount
 

    // Find or create prompt document and update tokens only
    let promptDoc = await Prompts.findOne({ user: userId, sessionActive: true });
    if (!promptDoc) {
      promptDoc = new Prompts({
        user: userId,
        tokens_used: tokensUsed,
        sessionActive: true
      });
    } else {
      promptDoc.tokens_used += tokensUsed;
    }
    await promptDoc.save();

    // Deduct 50% discounted tokens from user account
    const discountedTokens = Math.ceil(tokensUsed * discountMultiplier); // Apply the discount to the tokens
    const cost = discountedTokens; // Final cost after discount
    const userDoc = await User.findById(userId);
    if (userDoc) {
      userDoc.tokens = Math.max(0, (userDoc.tokens || 0) - cost);
      await userDoc.save();
    }

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
