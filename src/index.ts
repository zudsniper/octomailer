// src/index.ts
import { Octokit } from '@octokit/core';
import PostalMime from 'postal-mime';

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

class MissingDiscordEnvVariablesError extends Error {
	constructor() {
		super('DISCORD_WEBHOOK_URL or WEBHOOK_URL must be set for TYPE=discord');
		this.name = 'MissingDiscordEnvVariablesError';
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
 * Helper function to parse attachments from multipart email using postal-mime
 */
async function parseAttachments(rawData: string): Promise<EmailAttachment[]> {
    const attachments: EmailAttachment[] = [];
    
    try {
        const parser = new PostalMime();
        const email = await parser.parse(rawData);
        
        console.log('Parsed email with postal-mime, attachments count:', email.attachments?.length || 0);
        
        if (email.attachments) {
            for (const attachment of email.attachments) {
                if (attachment.mimeType?.startsWith('image/')) {
                    console.log(`Found image attachment: ${attachment.filename}, type: ${attachment.mimeType}`);
                    console.log(`Attachment content type: ${typeof attachment.content}, isArrayBuffer: ${attachment.content instanceof ArrayBuffer}`);
                    console.log(`Attachment encoding: ${attachment.encoding}`);
                    
                    // Convert ArrayBuffer to Uint8Array
                    let data: Uint8Array;
                    if (attachment.content instanceof ArrayBuffer) {
                        data = new Uint8Array(attachment.content);
                    } else if (typeof attachment.content === 'string') {
                        // If content is a string (base64), decode it
                        const binaryString = atob(attachment.content);
                        data = new Uint8Array(binaryString.length);
                        for (let i = 0; i < binaryString.length; i++) {
                            data[i] = binaryString.charCodeAt(i);
                        }
                    } else {
                        data = new Uint8Array(0);
                    }
                    
                    console.log(`Image data size after conversion: ${data.length} bytes`);
                    
                    attachments.push({
                        filename: attachment.filename || 'image',
                        contentType: attachment.mimeType,
                        data: data,
                        cid: attachment.contentId
                    });
                }
            }
        }
    } catch (error) {
        console.error('Error parsing email with postal-mime:', error);
    }
    
    return attachments;
}

/**
 * Parse email content to extract clean body text and attachments
 */
async function parseEmailContent(rawEmail: string): Promise<ParsedEmail> {
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
		.replace(/\[image:\s*[^\]]*\]/gi, '') // Remove [image: filename] placeholders
		.replace(/\[cid:[^\]]*\]/gi, '') // Remove [cid:...] references
		.split('\n')
		.filter(line => line.trim() !== '')
		.join('\n')
		.trim();

	// Parse attachments
	const attachments = await parseAttachments(rawEmail);

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

async function uploadImageToImgur(fileName: string, data: Uint8Array): Promise<string | null> {
    try {
        // Convert Uint8Array to base64 without using Buffer (not available in Workers)
        let binary = '';
        for (let i = 0; i < data.length; i++) {
            binary += String.fromCharCode(data[i]);
        }
        const base64Content = btoa(binary);
        
        // Upload to Imgur anonymously
        const response = await fetch('https://api.imgur.com/3/image', {
            method: 'POST',
            headers: {
                'Authorization': 'Client-ID 546c25a59c58ad7',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image: base64Content,
                type: 'base64',
                name: fileName
            })
        });
        
        if (!response.ok) {
            console.error('Imgur API error:', response.status, await response.text());
            return null;
        }
        
        const result = await response.json();
        if (result.success && result.data) {
            console.log(`Successfully uploaded image to Imgur: ${result.data.link}`);
            return result.data.link;
        } else {
            console.error('Imgur upload failed:', result);
            return null;
        }
    } catch (error) {
        console.error('Failed to upload image to Imgur:', error);
        return null;
    }
}

async function createIssue(message: ForwardableEmailMessage, env: Env, octokit: Octokit): Promise<void> {
	let parsedEmail: ParsedEmail;

	try {
		// Get the raw email content
		const rawEmailContent = await streamToText(message.raw);
		
		// Parse the email to extract clean content
		parsedEmail = await parseEmailContent(rawEmailContent);
		
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
			
			const imageUrl = await uploadImageToImgur(uniqueFileName, attachment.data);
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
		
		// Create the GitHub issue
		const response = await octokit.request('POST /repos/{owner}/{repo}/issues', issueParams);
		
		console.log('Issue created successfully:', response.data.html_url);
		
	} catch (error) {
		throw new CreateIssueError('Unable to parse email message contents or create GitHub issue', error as any);
	}
}

async function sendDiscordNotification(message: ForwardableEmailMessage, env: Env, webhookUrl: string): Promise<void> {
	// Parse raw email and attachments
	const rawEmailContent = await streamToText(message.raw);
	const parsedEmail = await parseEmailContent(rawEmailContent);

	if (!parsedEmail.subject.trim() || !parsedEmail.body.trim()) {
		console.log('Skipping email due to empty subject or body');
		return;
	}

	const senderEmail = extractEmailAddress(parsedEmail.from);

	// Upload image attachments to Imgur for stable URLs
	const imageUploadPromises = parsedEmail.attachments.map(async (attachment) => {
		const timestamp = Date.now();
		const safeName = attachment.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
		const uniqueFileName = `${timestamp}_${safeName}`;
		const imageUrl = await uploadImageToImgur(uniqueFileName, attachment.data);
		return imageUrl
			? { originalName: attachment.filename, uniqueFileName, imageUrl, cid: attachment.cid }
			: null;
	});
	const uploadedImages = (await Promise.all(imageUploadPromises)).filter(Boolean) as {
		originalName: string;
		uniqueFileName: string;
		imageUrl: string;
		cid?: string;
	}[];

	let description = parsedEmail.body;
	if (uploadedImages.length > 1) {
		description += '\n\nAttachments:';
		for (const img of uploadedImages.slice(1)) {
			description += `\n- ${img.originalName}: ${img.imageUrl}`;
		}
	}

	const authorName = parsedEmail.from || senderEmail || 'Unknown sender';
	const embed: any = {
		title: parsedEmail.subject.slice(0, 256),
		description: description.slice(0, 4096),
		color: 0x2b6cb0,
		author: { name: authorName.slice(0, 256) },
		fields: [
			{ name: 'From', value: senderEmail || parsedEmail.from || 'Unknown', inline: true },
		],
		footer: { text: 'octomailer • Cloudflare Workers' },
		timestamp: new Date().toISOString(),
	};

	if (uploadedImages.length > 0) {
		embed.image = { url: uploadedImages[0]!.imageUrl };
	}

	const mentionRoleId = env.DISCORD_MENTION_ROLE_ID;
	const content = mentionRoleId ? `<@&${mentionRoleId}>` : undefined;

	const payload = { content, embeds: [embed] };

	const resp = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Discord webhook failed: ${resp.status} ${text}`);
	}
}

export default {
	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		try {
			const mode = (env.TYPE || 'github').toLowerCase();

			if (mode === 'discord') {
				const webhookUrl = env.DISCORD_WEBHOOK_URL || env.WEBHOOK_URL;
				if (!webhookUrl) {
					const error = new MissingDiscordEnvVariablesError();
					console.error('Missing Discord webhook:', error.message);
					throw error;
				}

				const discordPromise = sendDiscordNotification(message, env, webhookUrl)
					.then(() => {
						console.log('Email processed successfully and Discord embed sent');
					})
					.catch((error) => {
						console.error('Failed to send Discord notification:', error);
						throw error;
					});

				ctx.waitUntil(discordPromise);
				await discordPromise;
				return;
			}

			// Default GitHub path
			const user = env.GITHUB_USERNAME;
			const repo = env.GITHUB_REPO;
			const token = env.GITHUB_TOKEN;

			if (!user || !repo || !token) {
				const error = new MissingEnvVariablesError();
				console.error('Missing environment variables:', error.message);
				throw error;
			}

			const octokit = new Octokit({ auth: token });

			const issueCreationPromise = createIssue(message, env, octokit)
				.then(() => {
					console.log('Email processed successfully and GitHub issue created');
				})
				.catch((error) => {
					console.error('Failed to process email:', error);
					if (error instanceof CreateIssueError) {
						console.error('Original error:', error.originalError);
					}
					throw error;
				});

			ctx.waitUntil(issueCreationPromise);
			await issueCreationPromise;
		} catch (error) {
			// Log the error for debugging purposes
			console.error('Email handler error:', error);
			
			// Re-throw the error to ensure proper error handling by the Workers runtime
			throw error;
		}
	},
};
