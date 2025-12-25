require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Queue = require('bull');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(__dirname, 'data.json');

function readData(){ return JSON.parse(fs.readFileSync(DATA_FILE)); }
function writeData(d){ fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }

const REDIS_URL = process.env.REDIS_URL || process.env.REDIS || null;
if (!REDIS_URL) {
  console.error('REDIS_URL not configured — worker exiting');
  process.exit(1);
}

const reportQueue = new Queue('reports', REDIS_URL);

console.log('Worker started, listening for report jobs...');

reportQueue.process(async (job, done) => {
  const { id, to } = job.data;
  console.log('Processing report job for', id, 'to:', to);
  const data = readData();
  const insp = data.inspections.find(x => x.id === id);
  if (!insp) {
    console.error('Inspection not found for job', id);
    return done(new Error('Inspection not found'));
  }

  // generate PDF via Puppeteer
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch (e) { console.error('puppeteer not available', e); return done(new Error('puppeteer not installed')); }

  try {
    const origin = process.env.ORIGIN || `http://localhost:${process.env.PORT || 3000}`;
    const previewUrl = `${origin}/reports/preview.html?id=${id}`;
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(previewUrl, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    const filename = `report-${id}.pdf`;
    const filepath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filepath, pdfBuffer);

    insp.report = insp.report || {};
    insp.report.path = `/uploads/${filename}`;
    insp.report.createdAt = Date.now();
    writeData(data);

    // attempt to email via SendGrid if API key available and 'to' provided (or insp.buyerEmail)
    const sendTo = to || insp.buyerEmail || null;
    if (process.env.SENDGRID_API_KEY && sendTo) {
      try {
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(process.env.SENDGRID_API_KEY);
        const from = process.env.SENDGRID_FROM || process.env.FROM_EMAIL || 'no-reply@trustcar.io';
        const msg = {
          to: sendTo,
          from,
          subject: `TrustCar Inspection Report — ${insp.id}`,
          text: `Attached is the inspection report for ${insp.id}`,
          attachments: [
            {
              content: pdfBuffer.toString('base64'),
              filename,
              type: 'application/pdf',
              disposition: 'attachment'
            }
          ]
        };
        await sgMail.send(msg);
        insp.report.emailed = true;
        insp.report.emailedAt = Date.now();
        insp.report.emailedTo = sendTo;
        writeData(data);
        console.log('Email sent to', sendTo);
        return done(null, { reportPath: insp.report.path, emailed: true });
      } catch (err) {
        console.error('sendgrid error', err);
        insp.report.emailed = false;
        insp.report.emailError = err.message;
        writeData(data);
        return done(err);
      }
    }

    // done without emailing
    console.log('Report saved, not emailed (SendGrid not configured or no recipient)');
    return done(null, { reportPath: insp.report.path, emailed: false });
  } catch (err) {
    console.error('worker pdf error', err);
    return done(err);
  }
});

reportQueue.on('failed', (job, err) => {
  console.error('Job failed', job.id, err);
});

reportQueue.on('completed', (job, result) => {
  console.log('Job completed', job.id, result);
});
