const express = require('express');
const https = require('https');
const router = express.Router();
const { ensureIoToken, fetchIoTokenForAccount, invalidateIoToken } = require('../utils/tokenManager');
const agent = new https.Agent({
  rejectUnauthorized: false, // Ignore invalid SSL just for this request
});

function mapToDbType(value) {
  if (value instanceof Date) return 'DateTime';
  const t = typeof value;
  if (t === 'boolean') return 'Bit';
  if (t === 'number') {
    // Choose Int32 for integers, Decimal for floats
    return Number.isInteger(value) ? 'Int32' : 'Decimal';
  }
  if (t === 'string') {
    // Basic heuristic: ISO date
    const d = Date.parse(value);
    if (!Number.isNaN(d) && /^\d{4}-\d{2}-\d{2}/.test(value)) return 'DateTime';
    return 'VarChar';
  }
  // Fallback for objects/arrays
  return 'VarChar';
}

// Replace string-only coercion with typed primitives to avoid String→Int errors
function toDbValue(value) {
  try {
    if (value instanceof Date) {
      return new Date(value).toISOString(); // keep as ISO string
    }
    const t = typeof value;
    if (t === 'boolean') return value;      // BIT: keep as boolean
    if (t === 'number') return value;       // numeric: keep as number
    if (t === 'string') return value;       // string: keep as string
    // Objects/arrays → JSON string
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Helper: format seconds or "HH:MM:SS" to "HH:MM:SS" for TIME
function formatTimeLike(value) {
  if (value == null) return '00:00:00';
  if (typeof value === 'string') {
    const m = value.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const h = m[1].padStart(2, '0');
      const mm = m[2].padStart(2, '0');
      const ss = (m[3] || '00').padStart(2, '0');
      return `${h}:${mm}:${ss}`;
    }
    const n = Number(value);
    if (Number.isFinite(n)) {
      return formatTimeLike(n);
    }
    return '00:00:00';
  }
  if (typeof value === 'number') {
    const secs = Math.max(0, Math.floor(value));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return '00:00:00';
}

async function handleRecordingUpload(req, res) {
  try {
    const IO_API_BASE = process.env.IO_API_BASE;
    if (!IO_API_BASE) {
      return res.status(500).json({ error: 'IO_API_BASE not configured' });
    }

    const aIS_RECORDING = req.body || {};
    if (!aIS_RECORDING || typeof aIS_RECORDING !== 'object') {
      return res.status(400).json({ error: 'AIS_RECORDING payload required in request body' });
    }

    const accountId = (req.query.accountId ?? aIS_RECORDING.accountId ?? '').toString().trim();

    const incomingApiKey =
      req.headers.apikey || req.headers['x-api-key'] || req.headers['apiKey'];
    const apiKeyHeader = incomingApiKey
      ? String(incomingApiKey)
      : `Bearer ${await (accountId ? fetchIoTokenForAccount(accountId) : ensureIoToken())}`;

    // Build parameters strictly from the recording service payload using explicit types
    const parameters = [
      {
        Name: '@RECORDING_ID',
        Value: Number.parseInt(String(aIS_RECORDING.RECORDING_ID ?? 0), 10),
        DbType: 'Int32',
      },
      {
        Name: '@ENCOUNTER_ID',
        Value: Number.parseInt(String(aIS_RECORDING.ENCOUNTER_ID ?? 0), 10),
        DbType: 'Int32',
      },
      {
        Name: '@RECORDING_NAME',
        Value: String(aIS_RECORDING.RECORDING_NAME ?? ''),
        DbType: 'VarChar',
      },
      {
        Name: '@RECORDING_GUID',
        Value: String(aIS_RECORDING.RECORDING_GUID ?? ''),
        DbType: 'VarChar',
      },
      {
        Name: '@PATIENT_ID',
        Value: String(aIS_RECORDING.PATIENT_ID ?? ''),
        DbType: 'VarChar',
      },
      {
        Name: '@DOCTOR_ID',
        Value: String(aIS_RECORDING.DOCTOR_ID ?? ''),
        DbType: 'VarChar',
      },
      {
        Name: '@EXPORTED_TO_ENC',
        Value: !!aIS_RECORDING.EXPORTED_TO_ENC,
        DbType: 'Bit',
      },
      {
        Name: '@RECORDING_LENGTH',
        Value: formatTimeLike(aIS_RECORDING.RECORDING_LENGTH),
        DbType: 'Varchar',
      },
      {
        Name: '@IS_FINALIZED',
        Value: !!aIS_RECORDING.IS_FINALIZED,
        DbType: 'Bit',
      },
      {
        Name: '@IS_REVIEWED',
        Value: !!aIS_RECORDING.IS_REVIEWED,
        DbType: 'Bit',
      },
      {
        Name: '@IS_TRANSCRIPTION_READY',
        Value: !!aIS_RECORDING.IS_TRANSCRIPTION_READY,
        DbType: 'Bit',
      },
      {
        Name: '@PATIENT_CONSENT_RECEIVED',
        Value: !!aIS_RECORDING.PATIENT_CONSENT_RECEIVED,
        DbType: 'Bit',
      },
      {
        Name: '@USER_ID',
        Value: Number.parseInt(String(aIS_RECORDING.USER_ID ?? 0), 10),
        DbType: 'Int32',
      },
      {
        Name: '@IS_PARTIAL',
        Value: !!aIS_RECORDING.IS_PARTIAL,
        DbType: 'Bit',
      },
    ].map(p => ({ ...p, Value: toDbValue(p.Value) }));

    // Debug: log types to pinpoint conversion issues
    const payload = {
      ProcedureName: 'AIS_INSERT_UPDATE_AIS_RECORDING',
      Parameters: parameters,
    };

    const target = `${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`;
    console.log(`[recording-upload] -> POST ${target} params=${parameters.length} accountId=${accountId || '(default)'} apiKeyHeader=${incomingApiKey ? 'yes' : 'no'}`);
 
    const resp = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: '*/*', apiKey: apiKeyHeader },
      body: JSON.stringify(payload),
      httpsAgent: agent,
    });
    console.log(`[recording-upload] response <- ${resp.status} ${resp.statusText}`);

    if (resp.status === 401) invalidateIoToken();

    const ct = resp.headers.get('content-type') || '';
    if (resp.status < 200 || resp.status >= 300) {
      const text = ct.includes('application/json') ? JSON.stringify(await resp.json()) : await resp.text();
      return res.status(resp.status).json({ error: 'ExecStoredProcedure upstream error', details: text });
    }

    let data;
    if (ct.includes('application/json')) {
      data = await resp.json();
    } else {
      const text = await resp.text();
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }

    const table = Array.isArray(data?.Table) ? data.Table : [];
    const firstRow = table[0] || null;
    const recordingIdRaw = firstRow ? (firstRow.RECORDING_ID ?? firstRow.recording_id ?? null) : null;
    const parsedRecordingId = recordingIdRaw != null ? Number(recordingIdRaw) : NaN;

    const requestedRecordingId = Number.parseInt(String(aIS_RECORDING.RECORDING_ID ?? 0), 10);
    const recordingIdToUse =
      Number.isFinite(requestedRecordingId) && requestedRecordingId > 0
        ? requestedRecordingId
        : parsedRecordingId;

    if (Number.isFinite(recordingIdToUse)) {
      console.log(`[recording-upload] <- RECORDING_ID=${recordingIdToUse} (requested=${requestedRecordingId || 0}, returned=${parsedRecordingId || 0})`);

      try {
        const jsonResp = (aIS_RECORDING && typeof aIS_RECORDING.jsonResponse === 'object')
          ? aIS_RECORDING.jsonResponse
          : {};

        // --- INSERT_UPDATE_SOAP_NOTES via TVP ---
        const soapNoteObj = jsonResp?.soap_note;
        if (soapNoteObj) {
          const userIdForNotes = Number.parseInt(String(aIS_RECORDING.USER_ID ?? aIS_RECORDING.userid ?? 0), 10) || 0;

          // Normalize to an array of notes
          const soapNotesArray = Array.isArray(soapNoteObj) ? soapNoteObj : [soapNoteObj];

          // Build TVP rows (aligns with your C# shape)
          const soapNotesData = soapNotesArray.map(note => {
            const elementId =
              Number.isFinite(Number.parseInt(String(note?.ELEMENT_ID ?? note?.element_id ?? '')))

                ? Number.parseInt(String(note?.ELEMENT_ID ?? note?.element_id ?? ''))
                : 7;

            const elementName = String(note?.ELEMENT_NAME ?? note?.element_name ?? 'SOAP_NOTE');

            const notesStr =
              typeof note?.NOTES === 'string'
                ? note.NOTES
                : JSON.stringify(note?.NOTES ?? note);

            const jsonTextStr =
              typeof note?.JSON_TEXT === 'string'
                ? note.JSON_TEXT
                : JSON.stringify(note?.JSON_TEXT ?? note);

            return {
              SOAP_ID: Number.parseInt(String(note?.SOAP_ID ?? 0), 10) || 0,
              RECORDING_ID: recordingIdToUse,
              ELEMENT_ID: elementId,
              NOTES: notesStr,
              EXPORTED_TO_ENC: Boolean(note?.EXPORTED_TO_ENC ?? false),
              USER_ID: userIdForNotes,
              JSON_TEXT: jsonTextStr,
              ELEMENT_NAME: elementName,
              PATIENT_ID: String(note?.PATIENT_ID ?? jsonResp?.patient_id ?? ''),
              ENCOUNTER_ID: String(note?.ENCOUNTER_ID ?? jsonResp?.encounter_id ?? '')
            };
          });

          if (soapNotesData.length > 0) {
            const soapPayload = {
              ProcedureName: 'AIS_INSERT_UPDATE_SOAP_NOTES',
              Parameters: [
                {
                  Name: '@TVP_AIS_SOAP_NOTES',
                  Value: soapNotesData, // TVP array
                  DbType: 'tvp'
                }
              ]
            };

            const soapResp = await fetch(`${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: '*/*', apiKey: apiKeyHeader },
              body: JSON.stringify(soapPayload),
              httpsAgent: agent
            });
            console.log(`[recording-upload] INSERT_UPDATE_SOAP_NOTES <- ${soapResp.status} ${soapResp.statusText}`);
            if (soapResp.status === 401) invalidateIoToken();
          } else {
            console.warn('[recording-upload] soapNotesData empty; skipping INSERT_UPDATE_SOAP_NOTES');
          }
        } else {
          console.warn('[recording-upload] No soap_note in jsonResponse; skipping INSERT_UPDATE_SOAP_NOTES');
        }

        // --- AIS_INSERT_UPDATE_AIS_DICTATION via TVP ---
        const transcriptText =
          (typeof jsonResp?.transcript === 'string' && jsonResp.transcript.trim()) ? jsonResp.transcript :
          (typeof jsonResp?.text === 'string' && jsonResp.text.trim()) ? jsonResp.text :
          '';

        if (transcriptText) {
          const userIdForDict = Number.parseInt(String(aIS_RECORDING.USER_ID ?? aIS_RECORDING.userid ?? 0), 10) || 0;
      
          // Build TVP rows. If you later have multiple speakers, map them here.
          const speakersTvp = [
            {
              DICTATION_ID: 0,
              RECORDING_ID: recordingIdToUse,
              IS_DOCTOR: false,
              IS_PATIENT: false,
              SPEAKER: '',
              DICTATION_TEXT: transcriptText.trim(),
              USER_ID: userIdForDict,
            }
          ];
      
          const dictationPayload = {
            ProcedureName: 'AIS_INSERT_UPDATE_AIS_DICTATION',
            Parameters: [
              { Name: '@TVP_AIS_DICTATIONS', Value: speakersTvp, DbType: 'tvp' }
            ]
          };
          console.log(`[recording-upload] AIS_INSERT_UPDATE_AIS_DICTATION payload:`, dictationPayload);
      
          const dictResp = await fetch(`${IO_API_BASE.replace(/\/$/, '')}/api/common/ExecStoredProcedure`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: '*/*', apiKey: apiKeyHeader },
            body: JSON.stringify(dictationPayload),
            httpsAgent: agent,
          });
          console.log(`[recording-upload] AIS_INSERT_UPDATE_AIS_DICTATION <- ${dictResp.status} ${dictResp.statusText}`);
          if (dictResp.status === 401) invalidateIoToken();
        } else {
          console.warn('[recording-upload] No transcript/text in jsonResponse; skipping AIS_INSERT_UPDATE_AIS_DICTATION');
        }
      } catch (postErr) {
        console.error('[recording-upload] post-save SOAP/DICTATION calls failed:', postErr);
      }

      return res.json({ Code: 200, Rid: recordingIdToUse, message: 'Recording chunk uploaded.' });
    }

    return res.json({ Message: 'No RECORDING_ID found in response.' });
  } catch (err) {
    console.error('[recording-upload] error:', { message: err.message, stack: err.stack });
    return res.status(500).json({ error: 'SAVE_AIS_RECORDING failed', details: err.message });
  }
}

router.post('/recording-upload', handleRecordingUpload);
// Also accept plain /api/FileUpload for backward compatibility
router.post('/', handleRecordingUpload);

module.exports = router;