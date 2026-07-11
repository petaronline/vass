# 02 — Meta setup

Vass talks to Meta's Marketing API. To do that, we need three things:

1. **App ID** + **App Secret** — identifies our app to Meta
2. **System User Token** — a long-lived token that lets us launch ads programmatically
3. **Business Manager ID** — your Meta Business Manager

You can complete this whole guide in ~15 minutes.

---

## Part A — Create a Meta App

1. Go to **[developers.facebook.com](https://developers.facebook.com)** and sign in with the Facebook account that owns your Business Manager.

2. Click **My Apps → Create App**.

3. Choose use case: **Other**.

4. Choose app type: **Business**.

5. Fill in:
   - **App name**: `Vass` (or `Hyper Studio Internal — Vass`)
   - **Contact email**: your email
   - **Business Account**: select your Hyper Studio Business Manager

6. Click **Create app**. You may be asked to enter your Facebook password.

7. Inside your new app, go to **Settings → Basic** in the left sidebar.

8. **Copy these two values, save them somewhere safe:**
   - **App ID** (a long number)
   - **App Secret** — click "Show", then copy

9. **Add the Marketing API product:**
   - In the left sidebar, click **+ Add Product**
   - Find **Marketing API** and click **Set Up**
   - You'll see it appear in the left sidebar — no further configuration needed yet

---

## Part B — Find your Business Manager ID

1. Go to **[business.facebook.com](https://business.facebook.com)**.

2. Click **Business Settings** (gear icon, top right).

3. In the left sidebar, click **Business Info**.

4. **Copy the Business Manager ID** — it's a long number near the top.

---

## Part C — Create a System User and generate a token

A System User is a special non-human account that owns your tokens. It doesn't belong to any person, so it never gets logged out, deactivated, or affected by people leaving the company.

1. In **Business Settings**, left sidebar → **Users → System Users**.

2. Click **Add**.

3. Fill in:
   - **System User Name**: `Vass Internal`
   - **System User Role**: **Admin**

4. Click **Create System User**.

5. With your new System User selected, click **Add Assets**.

6. In the popup:
   - **Asset Type**: Ad Accounts
   - **Select**: all the ad accounts Vass should be able to launch into (you can select multiple)
   - **Permissions**: enable **Manage campaigns**, **Manage creative**, and **View performance** (toggle all three on)
   - Click **Save Changes**

7. Repeat for any **Pages** that own the ads (if you'll use Page-linked ads):
   - **Asset Type**: Pages
   - **Select** the pages
   - **Permissions**: enable **Create content** and **Manage Page**
   - Click **Save Changes**

8. Now generate the token. With your System User selected, click **Generate New Token**.

9. In the popup:
   - **App**: select the **Vass** app you made in Part A
   - **Token expiration**: select **Never**
   - **Permissions** — tick these three:
     - `ads_management`
     - `ads_read`
     - `business_management`
   - Optionally also tick `pages_read_engagement` and `pages_manage_ads` if you'll use Page-linked features

10. Click **Generate Token**.

11. **A long token string appears. Copy it immediately — you cannot view it again.** Save it somewhere safe (password manager, encrypted notes, etc.). If you lose it, you'll have to generate a new one.

---

## Part D — Test your token works (optional but recommended)

You can verify the token works by pasting this into a terminal, replacing `YOUR_TOKEN_HERE`:

```bash
curl "https://graph.facebook.com/v21.0/me?access_token=YOUR_TOKEN_HERE"
```

Expected response:

```json
{
  "name": "Vass Internal",
  "id": "1234567890123456"
}
```

If you see that — token works.

To list the ad accounts your token has access to:

```bash
curl "https://graph.facebook.com/v21.0/me/adaccounts?access_token=YOUR_TOKEN_HERE"
```

You should see a list of `act_XXXXXXXXX` IDs.

---

## What you should now have

Save these somewhere safe — you'll plug them into `.env` in the next step:

| Variable | Source |
|---|---|
| `META_APP_ID` | Part A, step 8 |
| `META_APP_SECRET` | Part A, step 8 |
| `META_SYSTEM_USER_TOKEN` | Part C, step 11 |
| `META_BUSINESS_ID` | Part B, step 4 |

Next: [03-first-deploy.md](03-first-deploy.md) — deploy Vass to your server.

---

## Troubleshooting

**"I don't see Marketing API in the product list"** — Meta sometimes hides it for new accounts. Make sure your developer account is verified (you may need to add a phone number and credit card to your Facebook account). You may also need to wait 24h after creating the developer account.

**"Generate New Token is grayed out"** — You haven't added assets yet. Go back to step 5 in Part C.

**"My token doesn't have permission to launch ads"** — Re-check Part C step 6: did you enable **Manage campaigns**? Then re-generate the token (Part C step 8) and try again.

**"The token expired"** — You forgot to set "Never" expiration in step 9. Generate a new one with "Never" selected.
