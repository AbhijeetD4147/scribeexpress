require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { runQuery } = require('./db/pool');
const morgan = require('morgan');
const audioProcessRoutes = require("./routes/audioProcess");


const app = express();

app.use(cors({
  origin: true,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'apiKey', 'apikey', 'Accept']
}));
app.use(express.json());

// Request logging
morgan.token('auth', req => (req.headers.authorization ? 'yes' : 'no'));
morgan.token('apikey', req => (req.headers.apikey || req.headers['x-api-key'] ? 'yes' : 'no'));
const LOG_FORMAT = process.env.LOG_FORMAT || '[:date[iso]] :method :url :status :res[content-length] - :response-time ms auth=:auth apiKey=:apikey';
app.use(morgan(LOG_FORMAT));

// Routes
const tokenRoutes = require('./routes/token');
app.use('/api/token', tokenRoutes);
const ioRoutes = require('./routes/io');
app.use('/api/common', ioRoutes);

// Gate dictation DB route behind env
const dictationRoutes = require('./routes/dictation');
app.use('/api/dictation', dictationRoutes);
const recordingsRoutes = require('./routes/recordings');
app.use('/api/recordings', recordingsRoutes);
const soapnotesRoutes = require('./routes/soapnotes');
app.use('/api/soapnotes', soapnotesRoutes);

// Mount new update routes
const finalizeRoutes = require('./routes/finalize');
app.use('/api/finalize', finalizeRoutes);
const consentRoutes = require('./routes/consent');
app.use('/api/consent', consentRoutes);

// New route for handling recording uploads via DB
const uploadRoutes = require('./routes/upload');
app.use('/api/FileUpload', uploadRoutes);
const azureUploadRoutes = require('./routes/azureUpload');
app.use('/api/azure', azureUploadRoutes);
app.use("/api/audio", audioProcessRoutes);
const audioFileRetrieveRoutes = require('./routes/audiofileretrieve');
app.use("/api/audio", audioFileRetrieveRoutes);

// New route: SSO validation and redirect
const ssoRoutes = require('./routes/sso');
app.use('/api/sso', ssoRoutes);

// New route: send notes to Maximeyes
const sendNotesRoutes = require('./routes/sendNotesTomaximeyes');
app.use('/api/sendNotesTomaximeyes', sendNotesRoutes);

// New route: Customer proxy (GetTokenAsyncNew)
const customerRoutes = require('./routes/customer');
app.use('/api/Customer', customerRoutes);

// Fallback
app.get('/', (req, res) => {
  res.json({ name: 'Scribe Express Server', version: '1.0.0' });
});

// Start server
const PORT = parseInt(process.env.PORT || '5000', 10);
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});