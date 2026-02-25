# Lead Tracker (Free Stack)

A React + Firebase lead tracking app with:

- Email/password login
- Add/edit/delete leads
- Dashboard KPIs:
  - Total leads
  - Won jobs
  - Win rate
  - Total lead cost
  - Average reply time (numeric value parsed from the `Reply Time` field)
- Breakdown lists:
  - Leads by source
  - Leads by job type

## 1) Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

## 2) Firebase setup (free)

1. Go to https://console.firebase.google.com/
2. Create a project (Spark/free plan)
3. Add a **Web App** and copy config into `.env`
4. In Firebase Console:
   - **Authentication** → Enable **Email/Password**
   - **Firestore Database** → Create DB (production mode)

### Firestore security rules

Use these rules so each user only sees their own leads:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/leads/{leadId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## 3) Deploy to Vercel (free)

1. Push this folder to GitHub
2. In Vercel: **Add New Project** → import repo
3. Framework preset: **Vite**
4. Add same env vars from `.env.example` in Vercel project settings
5. Deploy

Optional CLI deploy:

```bash
npm i -g vercel
vercel
```

## Notes

- Click **Load sample leads** after login to insert your provided sample records.
- Lead cost accepts values like `$15`, `15`, `$0`.
- Reply time can stay text, but dashboard average uses the first number found.
