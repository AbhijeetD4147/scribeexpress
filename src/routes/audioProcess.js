const express = require("express");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const https = require("https"); // 👈 add this

const router = express.Router();
const upload = multer();

const PYTHON_API_BASE = process.env.PYTHON_API_BASE || "https://evaascribeprod.maximeyes.com/Scribe";

// 👇 Create an HTTPS agent to ignore invalid SSL in development
const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // ⚠️ disables SSL cert verification (DEV ONLY)
});

router.post("/process_audio_upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Prepare form data for Python API
    const fd = new FormData();
    fd.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    // Forward to Python API
    const targetUrl = `${PYTHON_API_BASE}/process_audio_upload`;
    const resp = await axios.post(targetUrl, fd, {
      headers: {
        ...fd.getHeaders(),
        Accept: "application/json",
      },
      httpsAgent, // 👈 attach the custom agent here
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });

    // Normalize response to always return JSON
    const normalize = (raw) => {
      if (raw == null) return { message: "Empty response from processing service" };
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch {
          const isHtml = /<\/?[a-z][\s\S]*>/i.test(raw);
          return isHtml
            ? { error: "Upstream returned HTML", html: raw }
            : { message: raw };
        }
      }
      return raw;
    };

    const payload = normalize(resp.data);
    return res.status(resp.status).json(payload);
  } catch (err) {
    console.error("[audio process] proxy error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
