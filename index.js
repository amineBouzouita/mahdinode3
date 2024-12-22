import { exec } from "child_process";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { promises as fs } from "fs";
import OpenAI from "openai";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(express.json());
app.use(cors());
const port = 3000;

// Multer configuration for file uploads
const upload = multer({ dest: "uploads/" });

// Helper function to execute shell commands
const execCommand = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject(error);
      resolve(stdout);
    });
  });
};

// Convert Text-to-Speech (TTS) using OpenAI
const textToSpeechOpenAI = async (text, outputFile) => {
  try {
    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: text,
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputFile, buffer);
    console.log(`TTS file saved as ${outputFile}`);
  } catch (error) {
    console.error("TTS Error:", error);
    throw new Error("Failed to generate TTS");
  }
};

// Speech-to-Text (STT) using OpenAI
const speechToTextOpenAI = async (filePath) => {
  try {
    const formData = new FormData();
    formData.append("file", await fs.readFile(filePath), "audio.mp3");
    formData.append("model", "whisper-1");

    const response = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      formData,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders(),
        },
      }
    );

    return response.data.text;
  } catch (error) {
    console.error("STT Error:", error.message);
    throw new Error("Failed to transcribe audio");
  }
};

// Convert audio file to base64
const audioFileToBase64 = async (file) => {
  const data = await fs.readFile(file);
  return data.toString("base64");
};

// Read lip sync JSON transcript
const readJsonTranscript = async (file) => {
  const data = await fs.readFile(file, "utf8");
  return JSON.parse(data);
};

// Convert audio for lip sync using Rhubarb
const lipSyncMessage = async (message) => {
  const time = new Date().getTime();
  console.log(`Starting conversion for message ${message}`);
  await execCommand(
    `ffmpeg -y -i audios/message_${message}.mp3 audios/message_${message}.wav`
  );
  console.log(`Conversion done in ${new Date().getTime() - time}ms`);
  await execCommand(
    `rhubarb.exe -f json -o audios/message_${message}.json audios/message_${message}.wav -r phonetic`
  );
  console.log(`Lip sync done in ${new Date().getTime() - time}ms`);
};

// ROUTES

// Default route
app.get("/", (req, res) => {
  res.send("Hello World!");
});

// STT Route - Speech-to-Text
app.post("/stt", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send({ error: "No audio file uploaded" });
    }
    const transcription = await speechToTextOpenAI(req.file.path);
    res.json({ text: transcription });

    // Remove the temporary uploaded file
    await fs.unlink(req.file.path);
  } catch (error) {
    console.error("STT Error:", error.message);
    res.status(500).send({ error: "Error in Speech-to-Text conversion" });
  }
});

// Chat Route with TTS and lip sync
app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;

  if (!userMessage) {
    res.send({
      messages: [
        {
          text: "Hello! How can I assist you today?",
          audio: await audioFileToBase64("audios/intro_0.wav"),
          lipsync: await readJsonTranscript("audios/intro_0.json"),
          facialExpression: "default",
          animation: "Talking_0",
        },
        {
          text: "I am here to help with professional advice and guidance.",
          audio: await audioFileToBase64("audios/intro_1.wav"),
          lipsync: await readJsonTranscript("audios/intro_1.json"),
          facialExpression: "smile",
          animation: "Talking_1",
        },
      ],
    });
    return;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo-1106",
      max_tokens: 1000,
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content: ` You are a professional virtual consultant.
        You will always reply with a JSON array of messages. With a maximum of 3 messages.
        Each message has a text, facialExpression, and animation property.
        The different facial expressions are: smile, serious, thoughtful, surprised, and default.
        The different animations are: Talking_0, Talking_1, Idle, Agreeing_0, and Agreeing_1. `,
        },
        { role: "user", content: userMessage },
      ],
    });

    let content = completion.choices[0].message.content;

    // Clean and parse JSON response
    content = content.replace(/```json|```/g, "").trim();
    let messages = JSON.parse(content);

    if (messages.messages) messages = messages.messages;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const fileName = `audios/message_${i}.mp3`;
      await textToSpeechOpenAI(message.text, fileName);
      await lipSyncMessage(i);
      message.audio = await audioFileToBase64(fileName);
      message.lipsync = await readJsonTranscript(`audios/message_${i}.json`);
    }

    res.send({ messages });
  } catch (error) {
    console.error("Chat Route Error:", error.message);
    res.status(500).send({ error: "Failed to generate response" });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Virtual Consultant listening on port ${port}`);
});
