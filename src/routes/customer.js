const express = require("express");
const router = express.Router();
const axios = require("axios");
const https = require("https");
const { getPool, sql } = require("../db/pool");
const { fetchIoTokenForAccount } = require("../utils/tokenManager");
const {
  getVendorCredentialsUsingAccountIdIO: mysqlGetVendorCredentialsUsingAccountIdIO,
} = require("../db/mysql");

// GET /api/Customer/GetTokenAsyncNew?accountId=...
router.get("/GetTokenAsyncNew", async (req, res) => {
  try {
    const accountId = String(req.query.accountId || "").trim();
    if (!accountId) {
      return res.status(400).json({ error: "accountId is required" });
    }

    const apiUrl = process.env.EXTERNAL_API_URL;
    if (!apiUrl) {
      return res.status(500).json({ error: "Missing EXTERNAL_API_URL in server/.env" });
    }

    // 1) Fetch vendor credentials from MySQL (mirrors your .NET method)
    const vendorCredentials = await mysqlGetVendorCredentialsUsingAccountIdIO(accountId);
    if (
      !vendorCredentials ||
      !vendorCredentials.VENDOR_GUID ||
      !vendorCredentials.VENDOR_PASSWORD ||
      !vendorCredentials.ACCOUNT_ID ||
      !vendorCredentials.ACCOUNT_PASSWORD
    ) {
      return res.status(404).json({ error: "Vendor credentials not found or incomplete" });
    }

    // 2) Prepare request body just like your .NET code
    const requestBody = {
      vendorid: vendorCredentials.VENDOR_GUID,
      vendorpassword: vendorCredentials.VENDOR_PASSWORD,
      accountid: vendorCredentials.ACCOUNT_ID,
      accountpassword: vendorCredentials.ACCOUNT_PASSWORD,
    };

    // 3) Dev-only TLS bypass to avoid 502 TLS_CERT_UNVERIFIED
    const httpsAgent =
      process.env.ALLOW_INSECURE_TLS === "true"
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined;

    // 4) POST to external API URL (no bearer)
    const resp = await axios.post(apiUrl, requestBody, {
      headers: { "Content-Type": "application/json", accept: "*/*" },
      httpsAgent,
      timeout: 10000,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      const body = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
      return res.status(resp.status).json({ error: "Upstream error", details: body });
    }

    // Normalize token response (string or { token: "..." })
    const token =
      typeof resp.data === "string"
        ? resp.data
        : resp.data?.token || JSON.stringify(resp.data);

    if (!token) {
      return res.status(500).json({ error: "Empty token from external API" });
    }

    // Return plain string to match C# Ok(result)
    return res.status(200).send(String(token));
  } catch (err) {
    const msg = err?.message || "Unknown error";
    console.error("[Customer] GetTokenAsyncNew error:", msg);

    if (/unable to verify/i.test(msg) || /UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(msg)) {
      return res
        .status(502)
        .json({ error: "Bad gateway", details: msg, code: "TLS_CERT_UNVERIFIED" });
    }
    return res.status(500).json({ error: "Internal server error", details: msg });
  }
});
module.exports = router;
