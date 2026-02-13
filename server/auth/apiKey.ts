import { timingSafeEqual } from 'crypto';
import { IncomingMessage } from 'http';
import { NextFunction, Request, Response } from 'express';

const DEFAULT_DEV_API_KEY = 'local-dev-api-key';
const API_KEY_SECRET = (process.env.API_KEY_SECRET || DEFAULT_DEV_API_KEY).trim();

if (!process.env.API_KEY_SECRET) {
    console.warn('[auth] API_KEY_SECRET is not set, using development fallback key');
}

function safeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    if (left.length !== right.length) {
        return false;
    }
    return timingSafeEqual(left, right);
}

function getApiKeyFromHeader(headers: IncomingMessage['headers']): string {
    const raw = headers['x-api-key'];
    if (Array.isArray(raw)) {
        return String(raw[0] || '').trim();
    }
    return String(raw || '').trim();
}

function getApiKeyFromAuthorization(headers: IncomingMessage['headers']): string {
    const authRaw = headers.authorization;
    const auth = Array.isArray(authRaw) ? String(authRaw[0] || '') : String(authRaw || '');
    const [scheme, token] = auth.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) {
        return token.trim();
    }
    return '';
}

function getApiKeyFromQuery(req: IncomingMessage): string {
    const url = req.url || '/';
    const parsed = new URL(url, 'http://localhost');
    return String(parsed.searchParams.get('apiKey') || '').trim();
}

function extractApiKey(req: IncomingMessage): string {
    return getApiKeyFromHeader(req.headers) || getApiKeyFromAuthorization(req.headers) || getApiKeyFromQuery(req);
}

export function isApiKeyValid(apiKey: string): boolean {
    if (!apiKey) {
        return false;
    }
    return safeEquals(apiKey, API_KEY_SECRET);
}

export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
    const apiKey = extractApiKey(req);
    if (!isApiKeyValid(apiKey)) {
        res.status(401).json({
            ok: false,
            error: 'unauthorized',
            message: 'Provide a valid API key in X-API-Key header or apiKey query parameter.',
        });
        return;
    }
    next();
}

export function validateWebSocketApiKey(req: IncomingMessage): { ok: boolean; reason?: string } {
    const apiKey = extractApiKey(req);
    if (!isApiKeyValid(apiKey)) {
        return { ok: false, reason: 'invalid_api_key' };
    }
    return { ok: true };
}
