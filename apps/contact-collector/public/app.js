const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ZIP = /^\d{5}$/;
const ORDER = ['email', 'zip', 'done'];

const form = document.querySelector('#signup');
const status = document.querySelector('#status');
const back = document.querySelector('#back');
const again = document.querySelector('#again');
const doneDetail = document.querySelector('#done-detail');
const flash = document.querySelector('#flash');
const steps = Object.fromEntries(
    ORDER.map((name) => [name, form.querySelector(`[data-step="${name}"]`)]),
);
const emailInput = form.elements.namedItem('email');
const zipInput = form.elements.namedItem('zip');
const next = form.querySelector('.next');
const submit = form.querySelector('.submit');
const submitLabel = submit.textContent;

let current = 'email';
let sending = false;

form.noValidate = true;
show('email', false);
arm();
intro();

emailInput.addEventListener('input', () => {
    status.textContent = '';
    arm();
});

zipInput.addEventListener('input', () => {
    zipInput.value = zipInput.value.replace(/\D/g, '').slice(0, 5);
    status.textContent = '';
    arm();
});

// A disabled submit button blocks implicit submission, so Enter is handled here.
for (const input of [emailInput, zipInput]) {
    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        advance();
    });
}

next.addEventListener('click', advance);
back.addEventListener('click', () => show('email'));
again.addEventListener('click', () => {
    form.reset();
    arm();
    show('email');
});

form.addEventListener('submit', (event) => {
    event.preventDefault();
    advance();
});

function advance() {
    if (sending) return;
    if (current === 'email') {
        emailInput.value = emailInput.value.trim();
        if (!EMAIL.test(emailInput.value)) return reject('email', 'Enter a valid email address.');
        show('zip');
        return;
    }
    if (current === 'zip') {
        if (!ZIP.test(zipInput.value)) return reject('zip', 'Enter a 5-digit ZIP code.');
        send();
    }
}

async function send() {
    sending = true;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    status.textContent = '';

    try {
        const response = await fetch('/api/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                email: emailInput.value,
                zip: zipInput.value,
                website: form.elements.namedItem('website').value,
            }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            status.textContent = payload.error || 'Something went wrong. Try again.';
            return;
        }
        doneDetail.textContent = `We'll email ${emailInput.value} if a wildfire threatens ${zipInput.value}.`;
        show('done');
        burst();
    } catch {
        status.textContent = 'Check your connection and try again.';
    } finally {
        sending = false;
        submit.textContent = submitLabel;
        arm();
    }
}

function arm() {
    const emailReady = EMAIL.test(emailInput.value.trim());
    const zipReady = ZIP.test(zipInput.value);
    steps.email.classList.toggle('armed', emailReady);
    steps.zip.classList.toggle('armed', zipReady);
    next.disabled = !emailReady;
    submit.disabled = !zipReady || sending;
}

function show(name, focus = true) {
    current = name;
    const at = ORDER.indexOf(name);
    for (const [index, step] of ORDER.entries()) {
        const element = steps[step];
        element.dataset.state = index < at ? 'past' : index > at ? 'ahead' : 'active';
        element.inert = index !== at;
    }
    status.textContent = '';
    back.hidden = name !== 'zip';
    back.textContent = name === 'zip' ? `${emailInput.value} · Change` : '';
    if (!focus) return;
    const target = name === 'email' ? emailInput : name === 'zip' ? zipInput : steps.done;
    target.focus({ preventScroll: true });
}

function reject(name, message) {
    status.textContent = message;
    const element = steps[name];
    element.classList.remove('shake');
    void element.offsetWidth;
    element.classList.add('shake');
}

function burst() {
    flash.classList.remove('burst');
    void flash.offsetWidth;
    flash.classList.add('burst');
    window.dispatchEvent(new Event('ember:flare'));
}

// The curtain lifts once the wordmark has landed and the scene has a frame, or after a cap.
function intro() {
    const started = performance.now();
    let lit = false;

    function ignite() {
        if (lit) return;
        lit = true;
        const wait = Math.max(0, 1000 - (performance.now() - started));
        setTimeout(() => {
            document.body.classList.add('lit');
            window.dispatchEvent(new Event('ember:ignite'));
            if (window.matchMedia('(pointer: fine)').matches) {
                setTimeout(() => emailInput.focus({ preventScroll: true }), 1500);
            }
        }, wait);
    }

    window.addEventListener('ember:scene-ready', ignite, { once: true });
    if (document.body.classList.contains('gl')) ignite();
    setTimeout(ignite, 2200);
}
