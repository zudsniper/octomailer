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

async function createIssue(message: ForwardableEmailMessage, env: Env, octokit: Octokit): Promise<void> {
	let messageTitle: string;
	let messageBody: string;

	try {
		messageTitle = message.headers.get('subject') || 'User feedback';
		messageBody = await streamToText(message.raw);
	} catch (error) {
		throw new CreateIssueError('Unable to parse email message contents', error as any);
	}

	try {
		await octokit.request('POST /repos/{owner}/{repo}/issues', {
			owner: env.GITHUB_USERNAME,
			repo: env.GITHUB_REPO,
			title: messageTitle,
			body: messageBody,
			labels: ['feedback'],
			headers: {
				'X-GitHub-Api-Version': '2022-11-28',
			},
		});
		console.log('Issue created successfully');
	} catch (error) {
		throw new CreateIssueError('Unable to create GitHub issue', error as any);
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
