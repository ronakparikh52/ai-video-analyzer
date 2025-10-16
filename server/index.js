import express from "express";
import cors from "cors";
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 8000;

// Parse JSON bodies (in frontend, we stringify the body so this converts it back)
app.use(express.json());

// Allow any origin of request for now (connect frontend to backend)
app.use(cors());

app.post("/", (req, res) => {
  // print to terminal where Node is running
  console.log("📩 POST / payload:", req.body);

  // echo back what we got
  return res.json({
    ok: true,
    youSent: req.body
  });
});

/**
 * Expected request body (all keys are JSON):
 *
 * {
 *   "question": "string (required)",
 *   "transcriptLast30": "string (optional but recommended: last ~30s)",
 *   "transcriptNext10": "string (optional: next ~10s)",
 *   "frames": [            // optional, up to 11 items (from -5..+5 seconds)
 *     { "secondOffset": -5, "imageBase64": "data:image/jpeg;base64,..." },
 *     { "secondOffset": -4, "imageBase64": "data:image/jpeg;base64,..." },
 *     ...
 *     { "secondOffset": 0,  "imageBase64": "data:image/jpeg;base64,..." },
 *     ...
 *     { "secondOffset": +5, "imageBase64": "data:image/jpeg;base64,..." }
 *   ],
 *   "videoTitle": "string (optional)",
 *   "videoDescription": "string (optional)"
 * }
 *
 * Notes:
 * - `frames` represents one frame per second from -5 to +5 around “now”.
 * - Images should be Data URLs, e.g., "data:image/jpeg;base64,/9j/4AAQ..." (png/jpg/webp ok).
 */

// ---------- helpers (kept simple & readable) ----------

// very light check that a string looks like a base64 image data URL
function isImageDataUrl(s) {
  if (typeof s !== "string") return false;
  return /^data:image\/(png|jpeg|jpg|webp);base64,/.test(s);
}

// take first N chars safely for previews
function preview(str, n = 140) {
  if (typeof str !== "string") return "";
  return str.length > n ? str.slice(0, n) + "..." : str;
}

// validate the incoming payload and return an array of error strings (empty if ok)
function validatePayload(body) {
  const errors = [];

  // question is required and should be a short string
  if (!body || typeof body.question !== "string" || !body.question.trim()) {
    errors.push("`question` (non-empty string) is required.");
  }

  // transcripts: optional but must be strings if provided
  if (body.transcriptLast30 != null && typeof body.transcriptLast30 !== "string") {
    errors.push("`transcriptLast30` must be a string if provided.");
  }
  if (body.transcriptNext10 != null && typeof body.transcriptNext10 !== "string") {
    errors.push("`transcriptNext10` must be a string if provided.");
  }

  // videoTitle/Description: optional strings
  if (body.videoTitle != null && typeof body.videoTitle !== "string") {
    errors.push("`videoTitle` must be a string if provided.");
  }
  if (body.videoDescription != null && typeof body.videoDescription !== "string") {
    errors.push("`videoDescription` must be a string if provided.");
  }

  // frames: optional array with constraints
  if (body.frames != null) {
    if (!Array.isArray(body.frames)) {
      errors.push("`frames` must be an array if provided.");
    } else {
      if (body.frames.length > 11) {
        errors.push("`frames` should contain at most 11 images (one per second from -5..+5).");
      }
      for (const f of body.frames) {
        if (typeof f !== "object" || f == null) {
          errors.push("Each frame must be an object with { secondOffset, imageBase64 }.");
          continue;
        }
        const { secondOffset, imageBase64 } = f;
        if (!Number.isInteger(secondOffset) || secondOffset < -5 || secondOffset > 5) {
          errors.push("`secondOffset` must be an integer between -5 and 5.");
        }
        if (!isImageDataUrl(imageBase64)) {
          errors.push("`imageBase64` must be a data URL like data:image/jpeg;base64,....");
        }
      }
    }
  }

  // At least one context piece (transcript or frames) is recommended
  const hasSomeContext =
    (typeof body.transcriptLast30 === "string" && body.transcriptLast30.trim().length > 0) ||
    (typeof body.transcriptNext10 === "string" && body.transcriptNext10.trim().length > 0) ||
    (Array.isArray(body.frames) && body.frames.length > 0);
  if (!hasSomeContext) {
    errors.push("Provide some context: `transcriptLast30` or `transcriptNext10` or `frames`.");
  }

  return errors;
}

// ---------- core route: POST /analyze ----------

app.post("/analyze", (req, res) => {
  const startedAt = Date.now();
  const body = req.body ?? {};
  const errors = validatePayload(body);

  if (errors.length) {
    return res.status(400).json({ ok: false, errors });
  }

  // normalize values (fallbacks to keep response consistent)
  const {
    question,
    transcriptLast30 = "",
    transcriptNext10 = "",
    videoTitle = "",
    videoDescription = "",
  } = body;

  // normalize/organize frames: sort by secondOffset and only return summaries (not the heavy images)
  let frames = Array.isArray(body.frames) ? body.frames.slice() : [];
  frames.sort((a, b) => a.secondOffset - b.secondOffset);

  // create a light summary for each frame (don’t echo the whole base64 back)
  const frameSummaries = frames.map((f) => {
    const sizeChars = typeof f.imageBase64 === "string" ? f.imageBase64.length : 0;
    return {
      secondOffset: f.secondOffset,
      mime: f.imageBase64.split(";")[0].replace("data:", ""), // e.g., "image/jpeg"
      approxChars: sizeChars, // rough size indicator; useful for debugging payload volume
    };
  });

  // Build a clean “normalized” object you could forward to an LLM later
  const normalized = {
    question: question.trim(),
    video: {
      title: videoTitle,
      description: videoDescription,
    },
    transcript: {
      last30: transcriptLast30,
      next10: transcriptNext10,
    },
    frames: frameSummaries, // light summaries only (not the base64)
  };

  // For now, just respond with a compact, human-readable summary + the normalized structure.
  const response = {
    ok: true,
    summary: {
      question: preview(normalized.question, 140),
      video: {
        hasTitle: Boolean(videoTitle),
        hasDescription: Boolean(videoDescription),
        titlePreview: preview(videoTitle, 80),
        descriptionPreview: preview(videoDescription, 120),
      },
      transcript: {
        last30Preview: preview(transcriptLast30, 140),
        next10Preview: preview(transcriptNext10, 140),
        last30Length: transcriptLast30.length,
        next10Length: transcriptNext10.length,
      },
      frames: {
        count: frameSummaries.length,
        offsets: frameSummaries.map((f) => f.secondOffset),
        mimes: [...new Set(frameSummaries.map((f) => f.mime))],
      },
    },
    normalized, // this is what you’d hand off to the model later
    meta: {
      durationMs: Date.now() - startedAt,
      receivedAt: new Date().toISOString(),
    },
  };

  return res.json(response);
});

// ---------- start server ----------
app.listen(PORT, () => {
  console.log(`✅ Server (ESM) running on http://localhost:${PORT}`);
});