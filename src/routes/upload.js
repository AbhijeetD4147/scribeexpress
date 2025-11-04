const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db/pool');
const { randomUUID } = require('crypto');

/**
 * Handles recording metadata submission and creates a conversation record in the database.
 * This is intended to replace the direct call to the .NET API's /FileUpload/recording-upload.
 */
async function handleRecordingUpload(req, res) {
  const {
    encounterId,
    jsonResponse,
    userid,
  } = req.body;

  // Ensure we have the minimum required data
  if (!encounterId || !jsonResponse) {
    return res.status(400).json({ error: 'encounterId and jsonResponse are required' });
  }

  console.log(`[upload] Received recording metadata for encounter ${encounterId}`);

  try {
    const pool = await getPool();
    const request = pool.request();

    // The ais_insert_conversations SP expects a few parameters.
    // We'll map the incoming payload to them.
    const conversationDesc = JSON.stringify(jsonResponse || {});
    const guid = randomUUID();

    // Setup stored procedure parameters
    request.output('p_conversation_id', sql.Int);
    request.input('p_conversation_description', sql.Text, conversationDesc);
    request.input('p_conversation_guid', sql.VarChar(100), guid);
    // NOTE: p_location_id is not in the client payload. Using a default of 1.
    request.input('p_location_id', sql.Int, 1);
    request.input('p_external_id', sql.VarChar(100), String(encounterId));
    request.input('p_json_exported', sql.Bit, true);
    request.input('p_exported_date', sql.DateTime, new Date());
    request.input('p_is_enabled', sql.Bit, true);
    request.input('p_is_active', sql.Bit, true);
    // Use the userid from payload, otherwise default to 1
    request.input('p_create_by', sql.Int, userid || 1);
    // Using default from SP definition
    request.input('p_create_process', sql.Int, 2);

    const result = await request.execute('ais_insert_conversations');

    const conversationId = result.output.p_conversation_id;
    console.log(`[upload] DB insert OK. New conversation_id: ${conversationId}`);

    // The client expects a response with `rid` for the subsequent Azure upload.
    res.status(200).json({ rid: conversationId, guid: guid });

  } catch (err) {
    console.error('[upload] DB insert error:', err);
    res.status(500).json({ error: 'Database insert failed', details: err.message });
  }
}

router.post('/recording-upload', handleRecordingUpload);
// Also accept plain /api/FileUpload for backward compatibility
router.post('/', handleRecordingUpload);

module.exports = router;