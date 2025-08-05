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

interface EmailAttachment {
	filename: string;
	contentType: string;
	data: Uint8Array;
	cid?: string; // Content-ID for inline images
}

interface ParsedEmail {
	body: string;
	from: string;
	subject: string;
	attachments: EmailAttachment[];
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
 * Helper function to parse attachments from multipart email
 */
function parseAttachments(rawData: string): EmailAttachment[] {
	const attachments: EmailAttachment[] = [];
	let boundary = '';

	// Try different boundary formats
	const boundaryMatch = rawData.match(/boundary="?([^"\s;]+)"?/i);
	if (boundaryMatch) {
		boundary = boundaryMatch[1];
	} else {
		return attachments; // No boundary found, no multipart content
	}

	// Split data by boundary
	const parts = rawData.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'));

	for (const part of parts) {
		if (!part.trim()) continue;

		// Look for Content-Type and Content-Disposition headers
		const contentTypeMatch = part.match(/Content-Type:\s*([^\s;]+)/i);
		const contentDispositionMatch = part.match(/Content-Disposition:\s*(?:attachment|inline)[^;]*;\s*filename="?([^"\n\r;]+)"?/i);
		const contentIDMatch = part.match(/Content-ID:\s*<([^>]+)>/i);
		const contentTransferEncodingMatch = part.match(/Content-Transfer-Encoding:\s*(\S+)/i);

		if (contentTypeMatch && (contentDispositionMatch || contentIDMatch)) {
			const contentType = contentTypeMatch[1].toLowerCase();
			const filename = contentDispositionMatch ? contentDispositionMatch[1] : (contentIDMatch ? contentIDMatch[1] : 'attachment');
			const cid = contentIDMatch ? contentIDMatch[1] : undefined;
			const encoding = contentTransferEncodingMatch ? contentTransferEncodingMatch[1].toLowerCase() : 'base64';

			// Find the actual data after headers (double newline separator)
			const headerEndIndex = part.indexOf('\n\n');
			if (headerEndIndex === -1) continue;
			
			const rawData = part.substring(headerEndIndex + 2).trim();
			if (!rawData) continue;

			// Decode based on encoding
			let data: Uint8Array;
			try {
				if (encoding === 'base64') {
					// Clean up base64 data (remove whitespace and newlines)
					const cleanBase64 = rawData.replace(/\s/g, '');
					data = new Uint8Array(Buffer.from(cleanBase64, 'base64'));
				} else if (encoding === 'quoted-printable') {
					// Basic quoted-printable decoding
					const decoded = rawData.replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
					data = new TextEncoder().encode(decoded);
				} else {
					// Default to treating as text
					data = new TextEncoder().encode(rawData);
				}
				
				// Only include image attachments for now
				if (contentType.startsWith('image/')) {
					attachments.push({ filename, contentType, data, cid });
				}
			} catch (error) {
				console.log('Error decoding attachment:', error);
				continue;
			}
		}
	}

	return attachments;
}

/**
 * Parse email content to extract clean body text and attachments
 */
function parseEmailContent(rawEmail: string): ParsedEmail {
	// Split the email into lines for processing
	const lines = rawEmail.split('\n');
	let headerSection = true;
	let headers = '';
	let textPlainLines: string[] = [];
	let textHtmlLines: string[] = [];
	let inTextPlain = false;
	let inTextHtml = false;
	let foundContentStart = false;

	// Process each line
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		
		if (headerSection) {
			// We're still in the header section
			if (line.trim() === '') {
				// Empty line indicates end of headers
				headerSection = false;
				continue;
			}
			headers += line + '\n';
		} else {
			// We're in the body section
			if (line.includes('Content-Type: text/plain')) {
				inTextPlain = true;
				inTextHtml = false;
				foundContentStart = false;
				continue;
			} else if (line.includes('Content-Type: text/html')) {
				inTextHtml = true;
				inTextPlain = false;
				foundContentStart = false;
				continue;
			} else if (line.startsWith('Content-Type:') || line.startsWith('Content-Transfer-Encoding:')) {
				// Skip other content headers
				continue;
			} else if (line.trim() === '' && (inTextPlain || inTextHtml) && !foundContentStart) {
				// Empty line after content-type headers indicates start of actual content
				foundContentStart = true;
				continue;
			} else if (line.startsWith('--') && line.includes('--')) {
				// MIME boundary - reset flags
				inTextPlain = false;
				inTextHtml = false;
				foundContentStart = false;
				continue;
			}
			
			// Collect content into separate arrays
			if (inTextPlain && foundContentStart) {
				textPlainLines.push(line);
			} else if (inTextHtml && foundContentStart) {
				textHtmlLines.push(line);
			}
		}
	}

	// Extract From header
	const fromMatch = headers.match(/^From:\s*(.+)$/m);
	const from = fromMatch ? fromMatch[1].trim() : '';

	// Extract Subject header
	const subjectMatch = headers.match(/^Subject:\s*(.+)$/m);
	const subject = subjectMatch ? subjectMatch[1].trim() : '';

	// Choose the best content: prefer plain text, fallback to HTML
	let body = '';
	if (textPlainLines.length > 0) {
		// Use plain text content
		body = textPlainLines.join('\n').trim();
	} else if (textHtmlLines.length > 0) {
		// Convert HTML content to markdown
		const htmlContent = textHtmlLines.join('\n').trim();
		body = convertHtmlToMarkdown(htmlContent);
	} else {
		// Fallback: try to extract any text content
		const fallbackLines = rawEmail.split('\n');
		let bodyStart = false;
		const contentLines: string[] = [];
		
		for (const line of fallbackLines) {
			if (bodyStart && !line.startsWith('Content-') && !line.startsWith('--') && line.trim() !== '') {
				contentLines.push(line);
			} else if (line.trim() === '' && !bodyStart) {
				bodyStart = true;
			}
		}
		
		body = contentLines.join('\n').trim();
	}

	// Final cleanup
	body = body
		.replace(/--[0-9a-f]+--/g, '')
		.replace(/^Content-Type:.*$/gm, '')
		.replace(/^Content-Transfer-Encoding:.*$/gm, '')
		.split('\n')
		.filter(line => line.trim() !== '')
		.join('\n')
		.trim();

	// Parse attachments
	const attachments = parseAttachments(rawEmail);

	return { body, from, subject, attachments };
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

async function uploadImageToGitHub(fileName: string, data: Uint8Array, env: Env, octokit: Octokit): Promise<string | null> {
    try {
        const response = await octokit.request('POST /repos/{owner}/{repo}/contents/{path}', {
            owner: env.GITHUB_USERNAME,
            repo: env.GITHUB_REPO,
            path: `images/${fileName}`,
            message: `Add image ${fileName}`,
            content: Buffer.from(data).toString('base64'),
            committer: {
                name: env.GITHUB_USERNAME,
                email: `${env.GITHUB_USERNAME}@users.noreply.github.com`
            },
            author: {
                name: env.GITHUB_USERNAME,
                email: `${env.GITHUB_USERNAME}@users.noreply.github.com`
            }
        });
        return response.data.content.html_url;
    } catch (error) {
        console.error('Failed to upload image:', error);
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
		
		// Check for subject and meaningful body
		if (!parsedEmail.subject.trim() || !parsedEmail.body.trim()) {
			console.log('Skipping email due to empty subject or body');
			return;
		}
		
		const messageTitle = parsedEmail.subject;
		
		console.log('Parsed email:', {
			subject: messageTitle,
			from: parsedEmail.from,
			bodyLength: parsedEmail.body.length,
			attachmentsCount: parsedEmail.attachments.length
		});
		
		// Extract sender email address
		const senderEmail = extractEmailAddress(parsedEmail.from);
		console.log('Sender email:', senderEmail);
		
		// Try to find GitHub user by email
		const githubUser = await findGitHubUserByEmail(senderEmail, octokit, env.GITHUB_USERNAME, env.GITHUB_REPO);
		console.log('Found GitHub user:', githubUser);
		
		// Process image attachments
		const imageUploadPromises = parsedEmail.attachments.map(async (attachment) => {
			// Generate a unique filename with timestamp
			const timestamp = Date.now();
			const safeName = attachment.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
			const uniqueFileName = `${timestamp}_${safeName}`;
			
			const imageUrl = await uploadImageToGitHub(uniqueFileName, attachment.data, env, octokit);
			if (imageUrl) {
				return {
					originalName: attachment.filename,
					uniqueFileName,
					imageUrl,
					cid: attachment.cid
				};
			}
			return null;
		});
		
		// Wait for all image uploads to complete
		const uploadedImages = (await Promise.all(imageUploadPromises)).filter(Boolean);
		
		console.log(`Uploaded ${uploadedImages.length} images`);
		
		// Prepare issue body - clean email content only
		let issueBody = parsedEmail.body;
		
		// Replace inline image references with GitHub URLs
		for (const image of uploadedImages) {
			if (image && image.cid) {
				// Replace cid references in HTML/text content
				const cidPattern = new RegExp(`cid:${image.cid}`, 'gi');
				issueBody = issueBody.replace(cidPattern, image.imageUrl);
			}
		}
		
		// Add all images as attachments at the end of the issue
		if (uploadedImages.length > 0) {
			issueBody += '\n\n## Attachments\n\n';
			for (const image of uploadedImages) {
				if (image) {
					issueBody += `![${image.originalName}](${image.imageUrl})\n\n`;
				}
			}
		}
		
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
