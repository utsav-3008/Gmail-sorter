import "dotenv/config";
import express from "express";
import session from "express-session";
import { google } from "googleapis";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const required = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "SESSION_SECRET"
];

for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

const app = express();
const port = Number(process.env.PORT || 3000);
const origin = `http://localhost:${port}`;
const directory = path.dirname(fileURLToPath(import.meta.url));

// Local demo only: sessions, credentials, and jobs are in memory.
const jobs = new Map();
const MAX_EXISTING_MESSAGES = 10000;

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // Local HTTP only. Use secure cookies over HTTPS in production.
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// Reject cross-origin requests that change state.
app.use("/api", (req, res, next) => {
  if (
    !["GET", "HEAD"].includes(req.method) &&
    req.get("origin") !== origin
  ) {
    return res.status(403).json({ error: "Invalid request origin." });
  }
  next();
});

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${origin}/auth/google/callback`
  );
}

function gmailFor(req) {
  const auth = createOAuthClient();
  auth.setCredentials(req.session.tokens);
  return google.gmail({ version: "v1", auth });
}

function requireLogin(req, res, next) {
  if (!req.session.tokens) {
    return res.status(401).json({ error: "Connect Gmail first." });
  }
  next();
}

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validateRule(body) {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";

  if (!query || query.length > 2000) {
    throw httpError("Enter a search query of 1–2000 characters.");
  }

  if (!label || label.length > 100) {
    throw httpError("Enter a label name of 1–100 characters.");
  }

  const rule = {
    query,
    label,
    archive: body.archive === true,
    existing: body.existing === true,
    future: body.future === true
  };

  if (!rule.existing && !rule.future) {
    throw httpError("Choose existing emails, future emails, or both.");
  }

  return rule;
}

app.get("/auth/google", (req, res) => {
  const state = randomBytes(32).toString("hex");
  req.session.oauthState = state;

  const url = createOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state,
    scope: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.settings.basic"
    ]
  });

  req.session.save((error) => {
    if (error) return res.status(500).send("Could not start sign-in.");
    res.redirect(url);
  });
});

app.get("/auth/google/callback", async (req, res) => {
  const expectedState = req.session.oauthState;
  delete req.session.oauthState;

  if (
    !expectedState ||
    typeof req.query.state !== "string" ||
    req.query.state !== expectedState ||
    typeof req.query.code !== "string"
  ) {
    return res.status(400).send("Sign-in failed. Return to the app and retry.");
  }

  try {
    const { tokens } = await createOAuthClient().getToken(req.query.code);

    // Rotate the session ID after authentication.
    await new Promise((resolve, reject) => {
      req.session.regenerate((error) => error ? reject(error) : resolve());
    });

    req.session.tokens = tokens;

    await new Promise((resolve, reject) => {
      req.session.save((error) => error ? reject(error) : resolve());
    });

    res.redirect("/");
  } catch {
    res.status(500).send("Could not connect Gmail. Check your Google setup.");
  }
});

app.get("/api/status", (req, res) => {
  res.json({ connected: Boolean(req.session.tokens) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.post("/api/preview", requireLogin, async (req, res, next) => {
  try {
    const rule = validateRule(req.body);
    const gmail = gmailFor(req);

    const { data } = await gmail.users.messages.list({
      userId: "me",
      q: rule.query,
      maxResults: 10
    });

    const messages = await Promise.all(
      (data.messages || []).map(async ({ id }) => {
        const { data: message } = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["Subject", "From", "Date"]
        });

        const headers = message.payload?.headers || [];
        const header = (name) =>
          headers.find(
            (item) => item.name.toLowerCase() === name.toLowerCase()
          )?.value || "";

        return {
          id,
          subject: header("Subject") || "(No subject)",
          from: header("From"),
          date: header("Date")
        };
      })
    );

    res.json({
      estimatedMatches: data.resultSizeEstimate || 0,
      messages
    });
  } catch (error) {
    next(error);
  }
});

async function findOrCreateLabel(gmail, name) {
  const { data } = await gmail.users.labels.list({ userId: "me" });
  const existing = (data.labels || []).find((label) => label.name === name);

  if (existing) {
    if (existing.type === "system") {
      throw httpError("Choose a custom label, not a Gmail system label.");
    }
    return existing.id;
  }

  const { data: created } = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show"
    }
  });

  return created.id;
}

async function collectMessageIds(gmail, query, job) {
  const ids = [];
  let pageToken;

  do {
    const { data } = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 500,
      pageToken
    });

    ids.push(...(data.messages || []).map((message) => message.id));
    job.found = ids.length;

    if (ids.length > MAX_EXISTING_MESSAGES) {
      throw httpError(
        `This starter allows at most ${MAX_EXISTING_MESSAGES} existing ` +
        "messages per run. Narrow the query and try again."
      );
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return ids;
}

async function runJob(gmail, rule, job) {
  try {
    job.status = "running";
    job.stage = "Finding existing messages";

    // Collect all IDs before changing labels so label-dependent queries
    // are not disrupted by our own changes during pagination.
    const ids = rule.existing
      ? await collectMessageIds(gmail, rule.query, job)
      : [];

    job.total = ids.length;
    job.stage = "Preparing destination label";
    const labelId = await findOrCreateLabel(gmail, rule.label);

    const actions = {
      addLabelIds: [labelId],
      ...(rule.archive ? { removeLabelIds: ["INBOX"] } : {})
    };

    if (rule.future) {
      job.stage = "Creating future-mail filter";

      // Avoid duplicating an identical filter created by this app.
      const { data } = await gmail.users.settings.filters.list({
        userId: "me"
      });

      const wanted = JSON.stringify({
        criteria: { query: rule.query },
        action: actions
      });

      const normalize = (filter) => JSON.stringify({
        criteria: filter.criteria || {},
        action: {
          addLabelIds: filter.action?.addLabelIds || [],
          ...(filter.action?.removeLabelIds?.length
            ? { removeLabelIds: filter.action.removeLabelIds }
            : {})
        }
      });

      const existing = (data.filter || []).find(
        (filter) => normalize(filter) === wanted
      );

      if (existing) {
        job.filterId = existing.id;
      } else {
        const { data: filter } =
          await gmail.users.settings.filters.create({
            userId: "me",
            requestBody: {
              criteria: { query: rule.query },
              action: actions
            }
          });

        job.filterId = filter.id;
      }
    }

    job.stage = "Updating existing messages";

    for (let index = 0; index < ids.length; index += 1000) {
      const batch = ids.slice(index, index + 1000);

      await gmail.users.messages.batchModify({
        userId: "me",
        requestBody: {
          ids: batch,
          ...actions
        }
      });

      job.processed += batch.length;
    }

    job.status = "done";
    job.stage = "Finished";
  } catch (error) {
    job.status = "error";
    job.error = error.message || "Sorting failed.";
    // Earlier successful changes are not rolled back.
  } finally {
    job.finishedAt = Date.now();
  }
}

app.post("/api/apply", requireLogin, async (req, res, next) => {
  try {
    const rule = validateRule(req.body);

    const active = [...jobs.values()].some(
      (job) =>
        job.owner === req.sessionID &&
        ["queued", "running"].includes(job.status)
    );

    if (active) {
      throw httpError("Wait for your current sorting job to finish.", 409);
    }

    const id = randomUUID();
    const job = {
      id,
      owner: req.sessionID,
      status: "queued",
      stage: "Queued",
      found: 0,
      total: 0,
      processed: 0,
      filterId: null
    };

    jobs.set(id, job);
    const gmail = gmailFor(req);

    res.status(202).json({ jobId: id });

    // Development-only background task. Keep this Node process running.
    setImmediate(() => runJob(gmail, rule, job));
  } catch (error) {
    next(error);
  }
});

app.get("/api/jobs/:id", requireLogin, (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || job.owner !== req.sessionID) {
    return res.status(404).json({ error: "Job not found." });
  }

  const { owner, ...publicJob } = job;
  res.json(publicJob);
});

// Remove completed job records after one hour.
setInterval(() => {
  for (const [id, job] of jobs) {
    if (job.finishedAt && Date.now() - job.finishedAt > 60 * 60 * 1000) {
      jobs.delete(id);
    }
  }
}, 60 * 1000).unref();

app.use(express.static(path.join(directory, "public")));

app.use((error, req, res, next) => {
  res.status(error.status || 500).json({
    error: error.message || "Something went wrong."
  });
});

// Bind locally; do not expose this development server to the internet.
app.listen(port, "localhost", () => {
  console.log(`Gmail Sorter: ${origin}`);
});