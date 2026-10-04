const SUCCESS_MESSAGE = "You're on the list. We'll text you if a wildfire threatens your area.";

export async function POST(request: Request): Promise<Response> {
    let submission: Submission;
    try {
        submission = await readSubmission(request);
    } catch (error) {
        if (error instanceof Response) return error;
        return json({ error: 'Enter a phone number and ZIP code.' }, 400);
    }

    if (submission.website) {
        return respond(submission.html, 200);
    }

    const phone = normalizePhone(submission.phone);
    const zipCode = normalizeZip(submission.zip);
    if (!phone || !zipCode) {
        return respond(
            submission.html,
            400,
            !phone ? 'Enter a 10-digit US phone number.' : 'Enter a 5-digit ZIP code.',
        );
    }

    const apiUrl = process.env.API_URL?.replace(/\/$/, '');
    if (!apiUrl) {
        return respond(submission.html, 500, 'Something went wrong. Try again.');
    }
    let response: Response;
    try {
        response = await fetch(`${apiUrl}/civilians`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ phone, zipCode }),
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
    phone: unknown;
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
            throw json({ error: 'Enter a phone number and ZIP code.' }, 400);
        }
        if (!body || typeof body !== 'object') {
            throw json({ error: 'Enter a phone number and ZIP code.' }, 400);
        }
        const record = body as Record<string, unknown>;
        return {
            phone: record.phone,
            zip: record.zip,
            website: record.website,
            html: false,
        };
    }

    const form = await request.formData();
    return {
        phone: form.get('phone'),
        zip: form.get('zip'),
        website: form.get('website'),
        html: true,
    };
}

function normalizePhone(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const digits = value.replace(/\D/g, '');
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (!/^[2-9]\d{9}$/.test(national)) return null;
    return `+1${national}`;
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
    <h1>ember</h1>
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
