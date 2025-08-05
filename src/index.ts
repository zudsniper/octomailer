// src/index.ts
import { Octokit } from '@octokit/core';

class CreateIssueError extends Error {
	constructor(message: string, public originalError: any) {
		super(message);
		this.name = 'CreateIssueError';
	}
}

class MissingEnvVariablesError extends Error {
	constructor() {
		super('GITHUB_USERNAME, GITHUB_REPO, and GITHUB_TOKEN must be set');
		this.name = 'MissingEnvVariablesError';
	}
}

interface ParsedEmail {
	body: string;
	from: string;
	subject: string;
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let result = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		result += decoder.decode(value, { stream: true });
	}

	result += decoder.decode();
	return result;
}

/**
 * Parse email content to extract clean body text
 */
function parseEmailContent(rawEmail: string): ParsedEmail {
	// Split headers and body
	const parts = rawEmail.split('\n\n');
	let headers = '';
	let body = '';
	
	if (parts.length >= 2) {
		headers = parts[0];
		body = parts.slice(1).join('\n\n');
	}

	// Extract From header
	const fromMatch = headers.match(/^From:\s*(.+)$/m);
	const from = fromMatch ? fromMatch[1].trim() : '';

	// Extract Subject header
	const subjectMatch = headers.match(/^Subject:\s*(.+)$/m);
	const subject = subjectMatch ? subjectMatch[1].trim() : 'Email to Issue';

	// Handle multipart content
	if (body.includes('Content-Type: multipart')) {
		// Find boundary
		const boundaryMatch = body.match(/boundary="([^"]+)"/i);
		if (boundaryMatch) {
			const boundary = boundaryMatch[1];
			const parts = body.split(`--${boundary}`);
			
			// Look for text/plain part first, fallback to text/html
			let textPart = '';
			let htmlPart = '';
			
			for (const part of parts) {
				if (part.includes('Content-Type: text/plain')) {
					// Extract content after headers
					const contentMatch = part.split('\n\n');
					if (contentMatch.length >= 2) {
						textPart = contentMatch.slice(1).join('\n\n').trim();
					}
				} else if (part.includes('Content-Type: text/html')) {
					// Extract HTML content and convert basic formatting
					const contentMatch = part.split('\n\n');
					if (contentMatch.length >= 2) {
						htmlPart = contentMatch.slice(1).join('\n\n').trim();
					}
				}
			}
			
			// Prefer plain text, fallback to converted HTML
			body = textPart || convertHtmlToMarkdown(htmlPart);
		}
	}

	// Clean up the body
	body = body.replace(/--[0-9a-f]+--/g, '').trim();
	
	// If body is still empty or mostly headers, try a different approach
	if (!body || body.length < 10) {
		// Look for the actual message content after all headers
		const lines = rawEmail.split('\n');
		let inBody = false;
		let bodyLines: string[] = [];
		
		for (const line of lines) {
			if (inBody) {
				if (!line.startsWith('--') || line.includes('Content-Type')) {
					bodyLines.push(line);
				}
			} else if (line.trim() === '' && bodyLines.length === 0) {
				inBody = true;
			}
		}
		
		body = bodyLines.join('\n').trim();
	}

	return { body, from, subject };
}

/**
 * Convert basic HTML formatting to Markdown
 */
function convertHtmlToMarkdown(html: string): string {
	if (!html) return '';
	
	return html
		// Remove HTML tags but preserve basic formatting
		.replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
		.replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
		.replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
		.replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<p[^>]*>/gi, '\n')
		.replace(/<\/p>/gi, '\n')
		.replace(/<[^>]+>/g, '') // Remove remaining HTML tags
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/=C2=A0/g, ' ') // Handle quoted-printable encoding
		.replace(/\n\s*\n/g, '\n\n') // Clean up multiple newlines
		.trim();
}

/**
 * Extract email address from From header
 */
function extractEmailAddress(fromHeader: string): string {
	const emailMatch = fromHeader.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
	return emailMatch ? emailMatch[0].toLowerCase() : '';
}

/**
 * Find GitHub user by email address
 */
async function findGitHubUserByEmail(email: string, octokit: Octokit, repoOwner: string, repoName: string): Promise<string | null> {
	if (!email) return null;
	
	try {
		// First, check if the email belongs to the repo owner
		const { data: ownerData } = await octokit.request('GET /users/{username}', {
			username: repoOwner,
		});
		
		if (ownerData.email && ownerData.email.toLowerCase() === email) {
			return repoOwner;
		}
		
		// Check organization members if the owner is an organization
		if (ownerData.type === 'Organization') {
			try {
				const { data: members } = await octokit.request('GET /orgs/{org}/members', {
					org: repoOwner,
				});
				
				// Check each member's email
				for (const member of members) {
					try {
						const { data: memberData } = await octokit.request('GET /users/{username}', {
							username: member.login,
						});
						
						if (memberData.email && memberData.email.toLowerCase() === email) {
							return member.login;
						}
					} catch (error) {
						// Skip members we can't access
						continue;
					}
				}
			} catch (error) {
				// Organization members might not be public
				console.log('Could not access organization members');
			}
		}
		
		// Check repository collaborators
		try {
			const { data: collaborators } = await octokit.request('GET /repos/{owner}/{repo}/collaborators', {
				owner: repoOwner,
				repo: repoName,
			});
			
			for (const collaborator of collaborators) {
				try {
					const { data: collabData } = await octokit.request('GET /users/{username}', {
						username: collaborator.login,
					});
					
					if (collabData.email && collabData.email.toLowerCase() === email) {
						return collaborator.login;
					}
				} catch (error) {
					// Skip collaborators we can't access
					continue;
				}
			}
		} catch (error) {
			console.log('Could not access repository collaborators');
		}
		return null;
	} catch (error) {
		console.log('Error finding GitHub user by email:', error);
		return null;
	}
}

async function createIssue(message: ForwardableEmailMessage, env: Env, octokit: Octokit): Promise<void> {
	let parsedEmail: ParsedEmail;

	try {
		// Get the raw email content
		const rawEmailContent = await streamToText(message.raw);
		
		// Parse the email to extract clean content
		parsedEmail = parseEmailContent(rawEmailContent);
		
		// Use the parsed subject, fallback to header or default
		const messageTitle = parsedEmail.subject || message.headers.get('subject') || 'Email to Issue';
		
		console.log('Parsed email:', {
			subject: messageTitle,
			from: parsedEmail.from,
			bodyLength: parsedEmail.body.length
		});
		
		// Extract sender email address
		const senderEmail = extractEmailAddress(parsedEmail.from);
		console.log('Sender email:', senderEmail);
		
		// Try to find GitHub user by email
		const githubUser = await findGitHubUserByEmail(senderEmail, octokit, env.GITHUB_USERNAME, env.GITHUB_REPO);
		console.log('Found GitHub user:', githubUser);
		
		// Prepare issue body - clean email content only
		let issueBody = parsedEmail.body;
		
		// If sender is a known GitHub user, include attribution
		if (githubUser && senderEmail) {
			issueBody += `\n\n---\n*Originally sent by @${githubUser} (${senderEmail})*`;
		}
		
		// Prepare issue creation parameters
		const issueParams: any = {
			owner: env.GITHUB_USERNAME,
			repo: env.GITHUB_REPO,
			title: messageTitle,
			body: issueBody,
			labels: ['email-to-issue'],
			headers: {
				'X-GitHub-Api-Version': '2022-11-28',
			},
		};
		
		// If we found a GitHub user and they're a member/collaborator, create issue on their behalf
		if (githubUser) {
			try {
				// Try to create the issue as the GitHub user (impersonation)
				// Note: This requires the token to have sufficient permissions
				// For now, we'll just add attribution in the body
				issueParams.labels.push('member-email');
			} catch (error) {
				console.log('Could not create issue on behalf of user, proceeding normally');
			}
		}
		
		await octokit.request('POST /repos/{owner}/{repo}/issues', issueParams);
		console.log('Issue created successfully');
		
	} catch (error) {
		throw new CreateIssueError('Unable to parse email message contents or create GitHub issue', error as any);
	}
}

export default {
	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		try {
			// Validate required environment variables
			const user = env.GITHUB_USERNAME;
			const repo = env.GITHUB_REPO;
			const token = env.GITHUB_TOKEN;

			if (!user || !repo || !token) {
				const error = new MissingEnvVariablesError();
				console.error('Missing environment variables:', error.message);
				throw error;
			}

			// Initialize Octokit
			const octokit = new Octokit({
				auth: token,
			});

			// Process the email and create GitHub issue
			// Use ctx.waitUntil to ensure the async operation completes even if the handler returns
			const issueCreationPromise = createIssue(message, env, octokit)
				.then(() => {
					console.log('Email processed successfully and GitHub issue created');
				})
				.catch((error) => {
					console.error('Failed to process email:', error);
					// Log additional error details for debugging
					if (error instanceof CreateIssueError) {
						console.error('Original error:', error.originalError);
					}
					// Re-throw to ensure the email handler reports failure
					throw error;
				});

			// Use waitUntil to ensure the issue creation completes
			ctx.waitUntil(issueCreationPromise);

			// Wait for the operation to complete before returning
			await issueCreationPromise;
		} catch (error) {
			// Log the error for debugging purposes
			console.error('Email handler error:', error);
			
			// Re-throw the error to ensure proper error handling by the Workers runtime
			throw error;
		}
	},
};
