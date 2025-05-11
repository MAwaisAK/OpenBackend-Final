import { ChatOpenAI } from "@langchain/openai";
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  FunctionMessage,
} from "@langchain/core/messages";
import { z } from "zod";
import redis from "../../clients/redis.js";
import LiftAi from "../../models/lift-ai.js";

// filesystem + doc generators
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph } from "docx";
import fs from "fs";
import path from "path";

// — function schemas —
const evaluationFunction = {
  name: "evaluate_answer",
  description: "Scores a user reply on relevance, completeness & feasibility",
  parameters: {
    type: "object",
    properties: {
      relevance:    { type: "integer", minimum: 1, maximum: 5 },
      completeness: { type: "integer", minimum: 1, maximum: 5 },
      feasibility:  { type: "integer", minimum: 1, maximum: 5 },
      comments:     { type: "string" }
    },
    required: ["relevance","completeness","feasibility"]
  }
};

const generateDocumentFunction = {
  name: "generate_document",
  description: "Generate a downloadable business analysis document",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string" },
      format:  { type: "string", enum: ["pdf","docx"] },
      userId:  { type: "string" }
    },
    required: ["content","format","userId"]
  }
};




function htmlify(text) {
  return text
    .replace(/(\*\*|__)(.*?)\1/g, '<b>$2</b>')
    .replace(/\n/g, '<br>');
}

const chatModel = new ChatOpenAI({
  openAIApiKey: process.env.OPENAI_API_KEY,
  modelName:    "gpt-4",
  temperature:  0.2,
  maxTokens:    512,
  functions:    [evaluationFunction, generateDocumentFunction],
  functionCall: "auto",
});

function sanitizeContent(raw) {
  return raw
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
}


// — helper to write PDF or DOCX into public/downloads/{userId} —
async function handleDocumentGeneration({ content, format, userId }) {
  content = sanitizeContent(content);

  const downloadsDir = path.join(process.cwd(), "public", "downloads", userId);
  await fs.promises.mkdir(downloadsDir, { recursive: true });

  const filename = `business_analysis_${Date.now()}.${format}`;
  const filePath = path.join(downloadsDir, filename);

  if (format === "pdf") {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    doc.fontSize(12).text(content, { align: "left" });
    doc.end();
    await new Promise(res => stream.on("finish", res));
  } else {
    const doc = new Document({
      sections: [{
        children: content
          .split("\n")
          .map(line => new Paragraph(line))
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(filePath, buffer);
  }

  return `/downloads/${userId}/${filename}`;
}


export async function handleUserInput(userId, userInput) {
  const memKey = `ba:memory:${userId}`;
  // Fetch systemPrompt from MongoDB
  const liftAiDoc = await LiftAi.findOne({}); // no filter since there's only one
  const systemPrompt = liftAiDoc?.prompt?.trim();
  let memoryMsgs = [];
  const raw = await redis.get(memKey);
  if (raw) {
    memoryMsgs = JSON.parse(raw);
  } else {
    memoryMsgs = [{ role: "system", content: systemPrompt }];
  }

  // — ADMIN: clear BA memory if requested —
  if (userInput.trim() === "Redis del all data") {
    const keys = await redis.keys("ba:memory:*");
    if (keys.length) await redis.del(...keys);
    return "✅ Cleared all BA memory.";
  }

  memoryMsgs.push({ role: "user", content: userInput });

  // build LangChain messages
  const chatMessages = memoryMsgs.map(m => {
    if (m.role === "system")    return new SystemMessage(m.content);
    if (m.role === "user")      return new HumanMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    if (m.role === "function")  return new FunctionMessage({ name: m.name, content: m.content });
    throw new Error("Unknown role " + m.role);
  });



  const fnCallMatch = userInput.match(
    /^generate_document\s*\(\s*(\{[\s\S]*\})\s*\)\s*$/i
  );
  if (fnCallMatch) {
    const args = JSON.parse(fnCallMatch[1]);

    const downloadUrl = await handleDocumentGeneration(args);
    memoryMsgs.push({
      role:    "assistant",
      name:    generateDocumentFunction.name,
      content: JSON.stringify({ downloadUrl }),
    });
    await redis.set(memKey, JSON.stringify(memoryMsgs));
    return { downloadUrl };
  }

  // ➋ normal LangChain/GPT functionCall path
  const responseMessage = await chatModel.invoke(chatMessages);
  let finalReply = responseMessage.text;
  const fnCall = responseMessage.additional_kwargs?.function_call;

  if (fnCall && fnCall.name === generateDocumentFunction.name) {
    const args = JSON.parse(fnCall.arguments || "{}");

    const downloadUrl = await handleDocumentGeneration(args);
    memoryMsgs.push({
      role:    "assistant",
      name:    fnCall.name,
      content: JSON.stringify({ downloadUrl }),
    });
    await redis.set(memKey, JSON.stringify(memoryMsgs));
    return { downloadUrl };
  }

  // ➌ fallback regex for anything that mentions “pdf” or “docx”
// ➌ fallback: user mentions download but didn't invoke function directly
const mentionsDownload = /\b(download|generate).*(pdf|docx)?\b/i.test(userInput);
const wantsPdf  = /\bpdf\b/i.test(userInput);
const wantsDocx = /\bdocx\b/i.test(userInput);

if (mentionsDownload) {
  const format = wantsPdf ? "pdf" : wantsDocx ? "docx" : null;

  if (!format) {
    return "Would you like to download it as a **PDF** or **DOCX**? Please reply with either 'Download as PDF' or 'Download as DOCX'.";
  }

  // get the last assistant reply (not a function response)
  const lastAssist = memoryMsgs
    .filter(m => m.role === "assistant" && !m.name && m.content)
    .slice(-1)[0]?.content || finalReply;

  const downloadUrl = await handleDocumentGeneration({
    content: lastAssist,
    format,
    userId
  });

  memoryMsgs.push({
    role:    "assistant",
    name:    generateDocumentFunction.name,
    content: JSON.stringify({ downloadUrl })
  });
  await redis.set(memKey, JSON.stringify(memoryMsgs));
  return { downloadUrl };
}


  // — normal assistant reply —
  const htmlReply = htmlify(finalReply);
  memoryMsgs.push({ role: "assistant", content: finalReply });
  await redis.set(memKey, JSON.stringify(memoryMsgs));
  return htmlReply;
}