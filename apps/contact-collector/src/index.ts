const SUCCESS_MESSAGE = "You're on the list. We'll email you if a wildfire threatens your area.";

interface Env {
    API_URL: string;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname !== '/api/subscribe') {
            return new Response('Not found', { status: 404 });
        }

        if (request.method !== 'POST') {
            return json({ error: 'Use the form to sign up.' }, 405);
        }

        return subscribe(request, env);
    },
};

async function subscribe(request: Request, env: Env): Promise<Response> {
    let submission: Submission;
    try {
        submission = await readSubmission(request);
    } catch (error) {
        if (error instanceof Response) return error;
        return json({ error: 'Enter an email address and ZIP code.' }, 400);
    }

    if (submission.website) {
        return respond(submission.html, 200);
    }

    const email = normalizeEmail(submission.email);
    const zipCode = normalizeZip(submission.zip);
    if (!email || !zipCode) {
        return respond(
            submission.html,
            400,
            !email ? 'Enter a valid email address.' : 'Enter a 5-digit ZIP code.',
        );
    }

    const apiUrl = env.API_URL.replace(/\/$/, '');
    let response: Response;
    try {
        response = await fetch(`${apiUrl}/civilians`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, zipCode }),
        });
    } catch {
        return respond(submission.html, 500, 'Something went wrong. Try again.');
    }

    if (response.ok || response.status === 409) {
        return respond(submission.html, 200);
    }

    return respond(submission.html, 500, 'Something went wrong. Try again.');
}

type Submission = {
    email: unknown;
    zip: unknown;
    website: unknown;
    html: boolean;
};

async function readSubmission(request: Request): Promise<Submission> {
    const contentType = request.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
        const text = await request.text();
        if (text.length > 2000) {
            throw json({ error: 'That request was too large.' }, 400);
        }
        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            throw json({ error: 'Enter an email address and ZIP code.' }, 400);
        }
        if (!body || typeof body !== 'object') {
            throw json({ error: 'Enter an email address and ZIP code.' }, 400);
        }
        const record = body as Record<string, unknown>;
        return {
            email: record.email,
            zip: record.zip,
            website: record.website,
            html: false,
        };
    }

    const form = await request.formData();
    return {
        email: form.get('email'),
        zip: form.get('zip'),
        website: form.get('website'),
        html: true,
    };
}

function normalizeEmail(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
    return email;
}

function normalizeZip(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const zip = value.trim();
    if (!/^\d{5}$/.test(zip)) return null;
    return zip;
}

function respond(html: boolean, status: number, error?: string): Response {
    if (!html) {
        if (error) return json({ error }, status);
        return json({ ok: true, message: SUCCESS_MESSAGE }, status);
    }

    const body = error
        ? `<p class="error">${escapeHtml(error)}</p><p><a href="/">Try again</a></p>`
        : `<p class="done">${escapeHtml(SUCCESS_MESSAGE)}</p>`;

    return new Response(
        `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Ember</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main>
    <h1>Ember</h1>
    ${body}
  </main>
</body>
</html>`,
        {
            status,
            headers: { 'content-type': 'text/html; charset=utf-8' },
        },
    );
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}
