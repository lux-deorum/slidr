# Live Q&A

A tiny web app for conference sessions: live polls, quizzes and audience questions.
No database, no build step, no dependencies — just Node.js (v18 or newer).

## Run it locally

```
node server.js
```

Open http://localhost:3000. (Set `PORT` to use a different port.)

## How it works

**Presenter**
1. Open the site → *I'm the presenter* → give the session a title. You get a 5-character code.
2. Add your polls and quizzes (2–5 options each; for a quiz, tick the correct answer). They stay as drafts, hidden from the audience.
3. Click **Open screen view** and put that window on the projector. It shows the join code until something goes live.
4. During the talk: **Go live** on a question → the audience can answer. **Show results** closes it and shows the bar chart (quizzes also highlight the correct answer).
5. The **Audience Q&A** tab collects questions throughout. Click **Show on screen** to put one up while you answer it, and **Mark answered** to move it down the list.

**Audience**
- Go to `your-site/#CODE` (or open the site → *I'm in the audience* → type the code).
- Live polls/quizzes appear on their phone; they can change their answer until results are shown.
- The *Ask the presenter* box is always available. Leaving the name blank posts anonymously.

**Tips**
- Your setup is saved in the browser you created it in. Run the session from that same browser.
- **Reset** puts a question back to draft and clears its votes — handy after a rehearsal.
- If the server restarts (e.g. a free host went to sleep), opening the presenter page restores your session and questions with the same code. Live votes and audience questions are only kept in memory, so avoid redeploying mid-session.

## Hosting

The app needs a host that runs a Node server continuously (static hosts like GitHub Pages or Netlify won't work, and neither will serverless functions). Run it as a **single instance**.

| Option | Cost | Notes |
|---|---|---|
| **Render** (web service) | Free tier | Easiest. Free services sleep after 15 min idle and take a short while to wake — open the presenter page ~5 minutes before your session. |
| **Railway** | Free plan with $1/month credit, or Hobby $5/month | Push from GitHub, auto-detects Node. Good if you want no sleep delays. |
| **Fly.io / any small VPS** | A few $/month | More setup; fine if you already use them. |

### Deploying to Render (≈5 minutes)
1. Put this folder in a GitHub repository.
2. On render.com: **New → Web Service** → connect the repo.
3. Runtime **Node**, Build command: *(leave blank)*, Start command: `node server.js`, Instance type: **Free**.
4. Deploy. Your app is live at `https://<name>.onrender.com`.

### Deploying to Railway
1. Put this folder in a GitHub repository.
2. On railway.com: **New Project → Deploy from GitHub repo**.
3. Once deployed, open **Settings → Networking → Generate Domain** to get a public URL.
