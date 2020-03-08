/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as https from 'https';
import * as querystring from 'querystring';
import * as vscode from 'vscode';
import { createServer, startServer } from './authServer';
import { keychain } from './keychain';
import Logger from './logger';
import { toBase64UrlEncoding } from './utils';

const redirectUrl = 'https://vscode-redirect.azurewebsites.net/';
const loginEndpointUrl = 'https://login.microsoftonline.com/';
const clientId = 'aebc6443-996d-45c2-90f0-388ff96faa56';
const tenant = 'organizations';

interface IToken {
	expiresIn: string; // How long access token is valid, in seconds
	accessToken: string;
	refreshToken: string;

	displayName: string;
	scope: string;
	sessionId: string; // The account id + the scope
}

interface ITokenClaims {
	tid: string;
	email?: string;
	unique_name?: string;
	oid?: string;
	altsecid?: string;
	scp: string;
}

interface IStoredSession {
	id: string;
	refreshToken: string;
	scope: string; // Scopes are alphabetized and joined with a space
}

function parseQuery(uri: vscode.Uri) {
	return uri.query.split('&').reduce((prev: any, current) => {
		const queryString = current.split('=');
		prev[queryString[0]] = queryString[1];
		return prev;
	}, {});
}

export const onDidChangeSessions = new vscode.EventEmitter<void>();

class UriEventHandler extends vscode.EventEmitter<vscode.Uri> implements vscode.UriHandler {
	public handleUri(uri: vscode.Uri) {
		this.fire(uri);
	}
}

export class AzureActiveDirectoryService {
	private _tokens: IToken[] = [];
	private _refreshTimeouts: Map<string, NodeJS.Timeout> = new Map<string, NodeJS.Timeout>();
	private _uriHandler: UriEventHandler;

	constructor() {
		this._uriHandler = new UriEventHandler();
		vscode.window.registerUriHandler(this._uriHandler);
	}

	public async initialize(): Promise<void> {
		const storedData = await keychain.getToken();
		if (storedData) {
			try {
				const sessions = this.parseStoredData(storedData);

				// TODO remove, temporary fix to delete duplicated refresh tokens from https://github.com/microsoft/vscode/issues/89334
				const seen: { [key: string]: boolean; } = Object.create(null);
				const dedupedSessions = sessions.filter(session => {
					if (seen[session.id]) {
						return false;
					}

					seen[session.id] = true;

					return true;
				});

				const refreshes = dedupedSessions.map(async session => {
					try {
						await this.refreshToken(session.refreshToken, session.scope);
					} catch (e) {
						await this.logout(session.id);
					}
				});

				await Promise.all(refreshes);
			} catch (e) {
				await this.clearSessions();
			}
		}

		this.pollForChange();
	}

	private parseStoredData(data: string): IStoredSession[] {
		return JSON.parse(data);
	}

	private async storeTokenData(): Promise<void> {
		const serializedData: IStoredSession[] = this._tokens.map(token => {
			return {
				id: token.sessionId,
				refreshToken: token.refreshToken,
				scope: token.scope
			};
		});

		await keychain.setToken(JSON.stringify(serializedData));
	}

	private pollForChange() {
		setTimeout(async () => {
			let didChange = false;
			const storedData = await keychain.getToken();
			if (storedData) {
				try {
					const sessions = this.parseStoredData(storedData);
					let promises = sessions.map(async session => {
						const matchesExisting = this._tokens.some(token => token.scope === session.scope && token.sessionId === session.id);
						if (!matchesExisting) {
							try {
								await this.refreshToken(session.refreshToken, session.scope);
								didChange = true;
							} catch (e) {
								await this.logout(session.id);
							}
						}
					});

					promises = promises.concat(this._tokens.map(async token => {
						const matchesExisting = sessions.some(session => token.scope === session.scope && token.sessionId === session.id);
						if (!matchesExisting) {
							await this.logout(token.sessionId);
							didChange = true;
						}
					}));

					await Promise.all(promises);
				} catch (e) {
					Logger.error(e.message);
					// if data is improperly formatted, remove all of it and send change event
					this.clearSessions();
					didChange = true;
				}
			} else {
				if (this._tokens.length) {
					// Log out all
					await this.clearSessions();
					didChange = true;
				}
			}

			if (didChange) {
				onDidChangeSessions.fire();
			}

			this.pollForChange();
		}, 1000 * 30);
	}

	private convertToSession(token: IToken): vscode.Session {
		return {
			id: token.sessionId,
			accessToken: token.accessToken,
			displayName: token.displayName,
			scopes: token.scope.split(' ')
		};
	}

	private getTokenClaims(accessToken: string): ITokenClaims {
		try {
			return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
		} catch (e) {
			Logger.error(e.message);
			throw new Error('Unable to read token claims');
		}
	}

	get sessions(): vscode.Session[] {
		return this._tokens.map(token => this.convertToSession(token));
	}

	public async login(scope: string): Promise<void> {
		Logger.info('Logging in...');

		if (vscode.env.uiKind === vscode.UIKind.Web) {
			await this.loginWithoutLocalServer(scope);
			return;
		}

		const nonce = crypto.randomBytes(16).toString('base64');
		const { server, redirectPromise, codePromise } = createServer(nonce);

		let token: IToken | undefined;
		try {
			const port = await startServer(server);
			vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/signin?nonce=${encodeURIComponent(nonce)}`));

			const redirectReq = await redirectPromise;
			if ('err' in redirectReq) {
				const { err, res } = redirectReq;
				res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
				res.end();
				throw err;
			}

			const host = redirectReq.req.headers.host || '';
			const updatedPortStr = (/^[^:]+:(\d+)$/.exec(Array.isArray(host) ? host[0] : host) || [])[1];
			const updatedPort = updatedPortStr ? parseInt(updatedPortStr, 10) : port;

			const state = `${updatedPort},${encodeURIComponent(nonce)}`;

			const codeVerifier = toBase64UrlEncoding(crypto.randomBytes(32).toString('base64'));
			const codeChallenge = toBase64UrlEncoding(crypto.createHash('sha256').update(codeVerifier).digest('base64'));
			const loginUrl = `${loginEndpointUrl}${tenant}/oauth2/v2.0/authorize?response_type=code&response_mode=query&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&state=${state}&scope=${encodeURIComponent(scope)}&prompt=select_account&code_challenge_method=S256&code_challenge=${codeChallenge}`;

			await redirectReq.res.writeHead(302, { Location: loginUrl });
			redirectReq.res.end();

			const codeRes = await codePromise;
			const res = codeRes.res;

			try {
				if ('err' in codeRes) {
					throw codeRes.err;
				}
				token = await this.exchangeCodeForToken(codeRes.code, codeVerifier, scope);
				this.setToken(token, scope);
				Logger.info('Login successful');
				res.writeHead(302, { Location: '/' });
				res.end();
			} catch (err) {
				Logger.error(err.message);
				res.writeHead(302, { Location: `/?error=${encodeURIComponent(err && err.message || 'Unknown error')}` });
				res.end();
			}
		} catch (e) {
			Logger.error(e.message);

			// If the error was about starting the server, try directly hitting the login endpoint instead
			if (e.message === 'Error listening to server' || e.message === 'Closed' || e.message === 'Timeout waiting for port') {
				await this.loginWithoutLocalServer(scope);
			}
		} finally {
			setTimeout(() => {
				server.close();
			}, 5000);
		}
	}

	private getCallbackEnvironment(callbackUri: vscode.Uri): string {
		switch (callbackUri.authority) {
			case 'online.visualstudio.com':
				return 'vso';
			case 'online-ppe.core.vsengsaas.visualstudio.com':
				return 'vsoppe';
			case 'online.dev.core.vsengsaas.visualstudio.com':
				return 'vsodev';
			default:
				return vscode.env.uriScheme;
		}
	}

	private async loginWithoutLocalServer(scope: string): Promise<IToken> {
		const callbackUri = await vscode.env.asExternalUri(vscode.Uri.parse(`${vscode.env.uriScheme}://vscode.vscode-account`));
		const nonce = crypto.randomBytes(16).toString('base64');
		const port = (callbackUri.authority.match(/:([0-9]*)$/) || [])[1] || (callbackUri.scheme === 'https' ? 443 : 80);
		const callbackEnvironment = this.getCallbackEnvironment(callbackUri);
		const state = `${callbackEnvironment},${port},${encodeURIComponent(nonce)},${encodeURIComponent(callbackUri.query)}`;
		const signInUrl = `${loginEndpointUrl}${tenant}/oauth2/v2.0/authorize`;
		let uri = vscode.Uri.parse(signInUrl);
		const codeVerifier = toBase64UrlEncoding(crypto.randomBytes(32).toString('base64'));
		const codeChallenge = toBase64UrlEncoding(crypto.createHash('sha256').update(codeVerifier).digest('base64'));
		uri = uri.with({
			query: `response_type=code&client_id=${encodeURIComponent(clientId)}&response_mode=query&redirect_uri=${redirectUrl}&state=${state}&scope=${scope}&prompt=select_account&code_challenge_method=S256&code_challenge=${codeChallenge}`
		});
		vscode.env.openExternal(uri);

		const timeoutPromise = new Promise((resolve: (value: IToken) => void, reject) => {
			const wait = setTimeout(() => {
				clearTimeout(wait);
				reject('Login timed out.');
			}, 1000 * 60 * 5);
		});

		return Promise.race([this.handleCodeResponse(state, codeVerifier, scope), timeoutPromise]);
	}

	private async handleCodeResponse(state: string, codeVerifier: string, scope: string) {
		let uriEventListener: vscode.Disposable;
		return new Promise((resolve: (value: IToken) => void, reject) => {
			uriEventListener = this._uriHandler.event(async (uri: vscode.Uri) => {
				try {
					const query = parseQuery(uri);
					const code = query.code;

					if (query.state !== state) {
						throw new Error('State does not match.');
					}

					const token = await this.exchangeCodeForToken(code, codeVerifier, scope);
					this.setToken(token, scope);

					resolve(token);
				} catch (err) {
					reject(err);
				}
			});
		}).then(result => {
			uriEventListener.dispose();
			return result;
		}).catch(err => {
			uriEventListener.dispose();
			throw err;
		});
	}

	private async setToken(token: IToken, scope: string): Promise<void> {
		const existingTokenIndex = this._tokens.findIndex(t => t.sessionId === token.sessionId);
		if (existingTokenIndex > -1) {
			this._tokens.splice(existingTokenIndex, 1, token);
		} else {
			this._tokens.push(token);
		}

		const existingTimeout = this._refreshTimeouts.get(token.sessionId);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}

		this._refreshTimeouts.set(token.sessionId, setTimeout(async () => {
			try {
				await this.refreshToken(token.refreshToken, scope);
			} catch (e) {
				await this.logout(token.sessionId);
			} finally {
				onDidChangeSessions.fire();
			}
		}, 1000 * (parseInt(token.expiresIn) - 10)));

		this.storeTokenData();
	}

	private getTokenFromResponse(buffer: Buffer[], scope: string): IToken {
		const json = JSON.parse(Buffer.concat(buffer).toString());
		const claims = this.getTokenClaims(json.access_token);
		return {
			expiresIn: json.expires_in,
			accessToken: json.access_token,
			refreshToken: json.refresh_token,
			scope,
			sessionId: claims.tid + (claims.oid || claims.altsecid) + scope,
			displayName: claims.email || claims.unique_name || 'user@example.com'
		};
	}

	private async exchangeCodeForToken(code: string, codeVerifier: string, scope: string): Promise<IToken> {
		return new Promise((resolve: (value: IToken) => void, reject) => {
			Logger.info('Exchanging login code for token');
			try {
				const postData = querystring.stringify({
					grant_type: 'authorization_code',
					code: code,
					client_id: clientId,
					scope: scope,
					code_verifier: codeVerifier,
					redirect_uri: redirectUrl
				});

				const tokenUrl = vscode.Uri.parse(`${loginEndpointUrl}${tenant}/oauth2/v2.0/token`);

				const post = https.request({
					host: tokenUrl.authority,
					path: tokenUrl.path,
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
						'Content-Length': postData.length
					}
				}, result => {
					const buffer: Buffer[] = [];
					result.on('data', (chunk: Buffer) => {
						buffer.push(chunk);
					});
					result.on('end', () => {
						if (result.statusCode === 200) {
							Logger.info('Exchanging login code for token success');
							resolve(this.getTokenFromResponse(buffer, scope));
						} else {
							Logger.error('Exchanging login code for token failed');
							reject(new Error('Unable to login.'));
						}
					});
				});

				post.write(postData);

				post.end();
				post.on('error', err => {
					reject(err);
				});

			} catch (e) {
				Logger.error(e.message);
				reject(e);
			}
		});
	}

	private async refreshToken(refreshToken: string, scope: string): Promise<IToken> {
		return new Promise((resolve: (value: IToken) => void, reject) => {
			Logger.info('Refreshing token...');
			const postData = querystring.stringify({
				refresh_token: refreshToken,
				client_id: clientId,
				grant_type: 'refresh_token',
				scope: scope
			});

			const post = https.request({
				host: 'login.microsoftonline.com',
				path: `/${tenant}/oauth2/v2.0/token`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Content-Length': postData.length
				}
			}, result => {
				const buffer: Buffer[] = [];
				result.on('data', (chunk: Buffer) => {
					buffer.push(chunk);
				});
				result.on('end', async () => {
					if (result.statusCode === 200) {
						const token = this.getTokenFromResponse(buffer, scope);
						this.setToken(token, scope);
						Logger.info('Token refresh success');
						resolve(token);
					} else {
						Logger.error('Refreshing token failed');
						reject(new Error('Refreshing token failed.'));
					}
				});
			});

			post.write(postData);

			post.end();
			post.on('error', err => {
				Logger.error(err.message);
				reject(err);
			});
		});
	}

	public async logout(sessionId: string) {
		Logger.info(`Logging out of session '${sessionId}'`);
		const tokenIndex = this._tokens.findIndex(token => token.sessionId === sessionId);
		if (tokenIndex > -1) {
			this._tokens.splice(tokenIndex, 1);
		}

		if (this._tokens.length === 0) {
			await keychain.deleteToken();
		} else {
			this.storeTokenData();
		}

		const timeout = this._refreshTimeouts.get(sessionId);
		if (timeout) {
			clearTimeout(timeout);
			this._refreshTimeouts.delete(sessionId);
		}
	}

	public async clearSessions() {
		Logger.info('Logging out of all sessions');
		this._tokens = [];
		await keychain.deleteToken();

		this._refreshTimeouts.forEach(timeout => {
			clearTimeout(timeout);
		});

		this._refreshTimeouts.clear();
	}
}
