const PHONE = /^[2-9]\d{9}$/;
const ZIP = /^\d{5}$/;
const ORDER = ['phone', 'zip', 'done'];

const form = document.querySelector('#signup');
const status = document.querySelector('#status');
const back = document.querySelector('#back');
const again = document.querySelector('#again');
const flash = document.querySelector('#flash');
const slides = Object.fromEntries(
    ORDER.map((name) => [name, form.querySelector(`[data-step="${name}"]`)]),
);
const phoneInput = form.elements.namedItem('phone');
const zipInput = form.elements.namedItem('zip');
const next = form.querySelector('.next');
const submit = form.querySelector('.submit');
const submitLabel = submit.textContent;

let current = 'phone';
let sending = false;

form.noValidate = true;
show('phone', false);
arm();
intro();

phoneInput.addEventListener('input', () => {
    phoneInput.value = formatPhone(phoneInput.value);
    clear();
    arm();
});

zipInput.addEventListener('input', () => {
    zipInput.value = zipInput.value.replace(/\D/g, '').slice(0, 5);
    clear();
    arm();
});

// A disabled submit button blocks implicit submission, so Enter is handled here.
for (const input of [phoneInput, zipInput]) {
    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        advance();
    });
}

next.addEventListener('click', advance);
back.addEventListener('click', () => show('phone'));
again.addEventListener('click', () => {
    form.reset();
    arm();
    show('phone');
});

form.addEventListener('submit', (event) => {
    event.preventDefault();
    advance();
});

function advance() {
    if (sending) return;
    if (current === 'phone') {
        if (!PHONE.test(digits(phoneInput.value))) {
            return reject('phone', 'Enter a 10-digit US phone number.');
        }
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
    clear();

    try {
        const response = await fetch('/api/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                phone: phoneInput.value,
                zip: zipInput.value,
                website: form.elements.namedItem('website').value,
            }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            reject('zip', payload.error || 'Something went wrong. Try again.');
            return;
        }
        show('done');
        status.textContent = "You're on the list.";
        burst();
    } catch {
        reject('zip', 'Check your connection and try again.');
    } finally {
        sending = false;
        submit.textContent = submitLabel;
        arm();
    }
}

function arm() {
    const phoneReady = PHONE.test(digits(phoneInput.value));
    const zipReady = ZIP.test(zipInput.value);
    slides.phone.classList.toggle('armed', phoneReady);
    slides.zip.classList.toggle('armed', zipReady);
    next.disabled = !phoneReady;
    submit.disabled = !zipReady || sending;
}

function show(name, focus = true) {
    current = name;
    const at = ORDER.indexOf(name);
    for (const [index, step] of ORDER.entries()) {
        const slide = slides[step];
        slide.dataset.state = index < at ? 'past' : index > at ? 'ahead' : 'active';
        slide.inert = index !== at;
    }
    clear();
    if (!focus) return;
    const target = name === 'phone' ? phoneInput : name === 'zip' ? zipInput : again;
    target.focus({ preventScroll: true });
}

function reject(name, message) {
    status.textContent = message;
    status.className = 'error';
    const slide = slides[name];
    slide.classList.remove('shake');
    void slide.offsetWidth;
    slide.classList.add('shake', 'invalid');
}

function clear() {
    status.textContent = '';
    status.className = 'sr-only';
    for (const slide of Object.values(slides)) slide.classList.remove('invalid');
}

// A leading country code 1 is dropped so "+1 555..." and "555..." read the same.
function digits(value) {
    const all = value.replace(/\D/g, '');
    return (all.length === 11 && all.startsWith('1') ? all.slice(1) : all).slice(0, 10);
}

function formatPhone(value) {
    const d = digits(value);
    if (d.length < 4) return d;
    if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
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
                setTimeout(() => phoneInput.focus({ preventScroll: true }), 1500);
            }
        }, wait);
    }

    window.addEventListener('ember:scene-ready', ignite, { once: true });
    if (document.body.classList.contains('gl')) ignite();
    setTimeout(ignite, 2200);
}
