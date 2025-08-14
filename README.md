# Octomailer

Octomailer transforms your email workflow by automatically creating GitHub issues from incoming emails using Cloudflare Workers. This serverless solution bridges the gap between email communication and issue tracking, making it perfect for support teams, project managers, and developers who need to convert email requests into actionable GitHub issues.

## Environment Variables

Before setting up Octomailer, you'll need to configure the following environment variables:

### Required Variables

- For GitHub mode (default):
  - **`GITHUB_USERNAME`**: Your GitHub username (e.g., `octocat`)
  - **`GITHUB_REPO`**: The repository name where issues will be created (e.g., `my-project`)
  - **`GITHUB_TOKEN`**: A GitHub personal access token with `repo` scope for creating issues
- For Discord mode:
  - **`TYPE`**: Set to `discord` to send Discord embeds instead of GitHub issues (defaults to `github`)
  - **`DISCORD_WEBHOOK_URL`** or **`WEBHOOK_URL`**: Discord webhook URL (prefers `DISCORD_WEBHOOK_URL` if both set)
  - Optional: **`DISCORD_MENTION_ROLE_ID`**: Discord role ID to ping (adds `<@&ROLE_ID>` to the message)

### Local Development Setup

For local development, create a `.dev.vars` file in the project root:

```bash
# .dev.vars
GITHUB_USERNAME=your-github-username
GITHUB_REPO=your-repository-name
GITHUB_TOKEN=your-personal-access-token
# TYPE can be switched to "discord" to send embeds
# TYPE=discord
# DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
# DISCORD_MENTION_ROLE_ID=123456789012345678
```

**Important:** Never commit `.dev.vars` to version control. This file is already included in `.gitignore`.

## Deployment

### Setting Up Secrets (Recommended)

For production deployment, it's recommended to use **secrets** instead of environment variables for sensitive data like tokens. Secrets are encrypted and more secure than regular environment variables.

#### Using Wrangler CLI (Recommended)

Set up your secrets using the Wrangler CLI:

```bash
# Set GitHub secrets - you'll be prompted to enter the values securely
wrangler secret put GITHUB_USERNAME
wrangler secret put GITHUB_REPO  
wrangler secret put GITHUB_TOKEN

# For Discord mode (if using TYPE=discord)
wrangler secret put DISCORD_WEBHOOK_URL
wrangler secret put DISCORD_MENTION_ROLE_ID # optional
wrangler secret put TYPE # set to "discord"
```

Alternatively, you can pipe values directly:

```bash
# Set secrets via command line (be careful with shell history)
echo "your-github-username" | wrangler secret put GITHUB_USERNAME
echo "your-repository-name" | wrangler secret put GITHUB_REPO
echo "your-personal-access-token" | wrangler secret put GITHUB_TOKEN
```

**Security Note**: Secrets are more secure than environment variables for sensitive data like tokens because they are encrypted at rest and in transit.

#### Using Cloudflare Dashboard (Alternative)

You can also set secrets through the Cloudflare Dashboard:

1. Go to your Cloudflare Dashboard
2. Navigate to **Workers & Pages** → **Your Worker** → **Settings** → **Variables**
3. Under **Environment Variables**, add each variable:
   - Set **Variable name** (e.g., `GITHUB_TOKEN`)
   - Set **Value** (your actual token)
   - **Important**: Check **Encrypt** for sensitive values like `GITHUB_TOKEN`
   - Click **Save**

### Customizing Your Worker

#### Changing the Worker Name

By default, the worker is named "octomailer". To change it to something more descriptive:

1. Edit the `wrangler.jsonc` file in your project root
2. Update the `name` field:

```toml
#:schema node_modules/wrangler/config-schema.json
name = "my-custom-email-processor"  # Change this to your preferred name
main = "src/index.ts"
compatibility_date = "2025-01-01"

# Enable Workers Logs for observability
[observability]
enabled = true
head_sampling_rate = 1.0
```

#### Configuring Cloudflare Account (Multiple Accounts)

If you have access to multiple Cloudflare accounts, you need to specify which account to deploy to:

**Option 1: Add account_id to wrangler.jsonc (Recommended)**

```toml
#:schema node_modules/wrangler/config-schema.json
name = "octomailer"
main = "src/index.ts"
compatibility_date = "2025-01-01"
account_id = "your-account-id-here"  # Add this line

# Enable Workers Logs for observability
[observability]
enabled = true
head_sampling_rate = 1.0
```

**Option 2: Use Environment Variable**

Set the `CLOUDFLARE_ACCOUNT_ID` environment variable:

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"
wrangler deploy
```

**Finding Your Account ID:**

1. Go to your Cloudflare Dashboard
2. Select your account (if you have multiple)
3. The Account ID is displayed in the right sidebar under **Account ID**
4. Or visit: `https://dash.cloudflare.com/profile` and copy the Account ID

**Note**: The account ID is not a secret—it's essentially a public key that identifies your Cloudflare account. However, for organization purposes, it's often cleaner to include it in `wrangler.jsonc`.

### Creating a GitHub Personal Access Token

To generate the required GitHub token:

1. Go to [GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)](https://github.com/settings/tokens)
2. Click **"Generate new token"** → **"Generate new token (classic)"**
3. Configure your token:
   - **Note**: Enter a descriptive name (e.g., "Octomailer Worker")
   - **Expiration**: Choose an appropriate expiration period
   - **Scopes**: Select **`repo`** (Full control of private repositories)
4. Click **"Generate token"**
5. **Important**: Copy the token immediately - you won't be able to see it again!

**Security Note**: Store your token securely and never share it publicly. If compromised, regenerate it immediately.

## How It Works

Octomailer follows a simple, efficient flow:

**Email → Cloudflare Worker → GitHub Issue**

1. **Email Received**: An email is sent to your configured email address
2. **Worker Processing**: Cloudflare Workers intercepts and processes the email
3. **GitHub Integration**: The worker automatically creates a GitHub issue with:
   - Email subject as the issue title
   - Email body as the issue description
   - Sender information and metadata as labels/comments
4. **Image Processing**: Image attachments are automatically uploaded to Imgur and embedded in the issue
5. **Instant Tracking**: Your email request is now a trackable GitHub issue

## Key Features & Benefits

- **🚀 Serverless Architecture**: Zero infrastructure management with Cloudflare Workers
- **📧 Email-to-Issue Conversion**: Seamlessly transform emails into structured GitHub issues
- **🖼️ Image Attachment Support**: Automatically uploads image attachments to Imgur and embeds them in issues
- **📝 Smart Email Parsing**: Advanced MIME parsing with `postal-mime` for multipart emails
- **🧹 Clean Content Processing**: Removes email headers, MIME boundaries, and image placeholders
- **👤 GitHub User Detection**: Automatically identifies GitHub users by email and adds attribution
- **⚡ Real-time Processing**: Instant issue creation as emails arrive
- **🔒 Secure & Reliable**: Built on Cloudflare's global network with enterprise-grade security
- **💰 Cost-Effective**: Pay only for what you use with Cloudflare's pricing model
- **🛠️ TypeScript Powered**: Robust type-checking and excellent developer experience
- **📱 Automated Deployment**: Simple deployment with Cloudflare Wrangler CLI
- **🏷️ Smart Labeling**: Automatic categorization and labeling based on email content
- **📈 Scalable**: Handles high email volumes without performance degradation

## Installation

### Prerequisites

- Node.js (>= 16.13)
- npm or yarn
- Cloudflare account
- GitHub account

### Setup

1. **Clone the repository:**

   ```sh
   git clone https://github.com/willswire/octomailer.git
   cd octomailer
   ```

2. **Install dependencies:**

   ```sh
   npm install
   ```

3. **Set up GitHub Authentication:**

   Ensure you have a GitHub token with the necessary permissions to create issues in your repository. Set this token as an environment variable in Cloudflare Workers.

## Scripts

The following scripts are available in the project:

- **Deploy**: Deploy the project to Cloudflare Workers.

  ```sh
  npm run deploy
  ```

- **Development**: Start a development server for Cloudflare Workers.

  ```sh
  npm run dev
  ```

- **Start**: Alias for the development server.

  ```sh
  npm run start
  ```

- **Test**: Run the test suite using Vitest.

  ```sh
  npm run test
  ```

- **Generate Types**: Generate type definitions for Cloudflare Workers.

  ```sh
  npm run cf-typegen
  ```

### Interactive Deploy CLI

Use the guided CLI to set secrets and deploy a custom-named Worker:

```sh
# npm
npm run deploy:interactive -- --name my-worker --type discord

# pnpm
pnpm run deploy:interactive -- --name my-worker --type github
```

- Flags: `--name|-n <worker-name>`, `--type|-t <github|discord>`.
- GitHub mode: prompts for `GITHUB_USERNAME`, `GITHUB_REPO`, and a PAT (link provided with `repo` scope). Stores as Wrangler secrets and sets `TYPE=github`.
- Discord mode: prompts for `DISCORD_WEBHOOK_URL` and optional `DISCORD_MENTION_ROLE_ID`. Stores as Wrangler secrets and sets `TYPE=discord`.
- Finally runs `wrangler deploy --name <worker-name>`.

Non-interactive (CI) usage:

```sh
node scripts/deploy.js --ci \
  --name my-worker \
  --type github \
  --gh-user $GITHUB_USERNAME \
  --gh-repo $GITHUB_REPO \
  --gh-token $GITHUB_TOKEN

# Or for Discord
node scripts/deploy.js --ci \
  --name my-worker \
  --type discord \
  --webhook $DISCORD_WEBHOOK_URL \
  --role-id $DISCORD_MENTION_ROLE_ID
```

Alternatively, set env vars: `WORKER_NAME`, `TYPE`, `GITHUB_USERNAME`, `GITHUB_REPO`, `GITHUB_TOKEN`, `DISCORD_WEBHOOK_URL` (or `WEBHOOK_URL`), `DISCORD_MENTION_ROLE_ID`.

## Advanced Features

### Image Attachment Processing

Octomailer automatically handles image attachments in emails with sophisticated processing:

- **Automatic Detection**: Detects image attachments (JPEG, PNG, GIF, etc.) in multipart emails
- **Imgur Integration**: Uploads images anonymously to Imgur for reliable hosting
- **Issue Embedding**: Embeds uploaded images directly in GitHub issues using Markdown syntax
- **Content-ID Replacement**: Replaces inline image references (`cid:`) with actual image URLs
- **Clean Presentation**: Removes image placeholder text like `[image: filename.png]` from issue body

### Smart Email Parsing

The service uses advanced email parsing techniques:

- **MIME Support**: Full support for multipart MIME emails using `postal-mime` library
- **Content Type Detection**: Intelligently handles both plain text and HTML email content
- **HTML to Markdown**: Converts HTML emails to clean Markdown format
- **Header Extraction**: Properly extracts email headers (From, Subject, etc.)
- **Content Cleaning**: Removes MIME boundaries, headers, and email artifacts

### GitHub User Attribution

Octomailer can identify and attribute GitHub users:

- **Email Matching**: Matches sender email addresses to GitHub user accounts
- **Repository Access**: Checks repository collaborators and organization members
- **Automatic Attribution**: Adds `@mention` attribution for recognized users
- **Smart Labeling**: Adds `member-email` label for emails from known contributors

### Error Handling & Logging

- **Comprehensive Logging**: Detailed debug logs for troubleshooting email processing
- **Graceful Failures**: Continues processing even if individual components fail
- **Error Context**: Provides detailed error information for debugging
- **Async Processing**: Uses Cloudflare Workers' `waitUntil` for reliable async operations

## Testing

Testing is done using Vitest. Ensure you have configured Vitest in your `vitest.config.ts` file. To run tests, use:

```sh
npm run test
```

## License

This project is licensed under the MIT License.

---

Feel free to contribute to this project by opening issues or submitting pull requests on GitHub.

---

This project is inspired by the need to automate and streamline the process of creating GitHub issues directly from emails, leveraging the power of Cloudflare Workers for serverless processing.

---

For more information on Cloudflare Workers and how to deploy serverless applications, visit the [Cloudflare Workers documentation](https://developers.cloudflare.com/workers/).

---

Happy coding!
