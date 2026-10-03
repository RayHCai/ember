const form = document.querySelector('#signup');
const status = document.querySelector('#status');
const button = form.querySelector('button');
const phoneInput = form.querySelector('input[name="phone"]');
const zipInput = form.querySelector('input[name="zip"]');
const confirmSheet = document.querySelector('#confirm');
const confirmClose = document.querySelector('#confirm-close');
const flash = document.querySelector('#flash');

bindMask(phoneInput, formatPhone);
bindMask(zipInput, formatZip);

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    phoneInput.value = formatPhone(phoneInput.value);
    zipInput.value = formatZip(zipInput.value);
    status.textContent = '';
    button.disabled = true;
    const label = button.textContent;
    button.textContent = 'Sending…';

    const data = new FormData(form);

    try {
        const response = await fetch('/api/subscribe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                phone: data.get('phone'),
                zip: data.get('zip'),
                website: data.get('website'),
            }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            status.textContent = payload.error || 'Something went wrong. Try again.';
            button.disabled = false;
            button.textContent = label;
            return;
        }
        form.reset();
        button.disabled = false;
        button.textContent = label;
        openConfirm();
    } catch {
        status.textContent = 'Check your connection and try again.';
        button.disabled = false;
        button.textContent = label;
    }
});

confirmSheet.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-close]')) {
        closeConfirm();
    }
});

function openConfirm() {
    flash.classList.remove('burst');
    void flash.offsetWidth;
    flash.classList.add('burst');
    confirmSheet.hidden = false;
    document.body.style.overflow = 'hidden';
    confirmClose.focus();
    document.addEventListener('keydown', onConfirmKey);
}

function closeConfirm() {
    confirmSheet.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onConfirmKey);
    phoneInput.focus();
}

function onConfirmKey(event) {
    if (event.key === 'Escape') closeConfirm();
}

function bindMask(input, format) {
    input.addEventListener('input', () => {
        const cursor = input.selectionStart ?? input.value.length;
        const digitsBefore = countDigits(input.value.slice(0, cursor));
        const formatted = format(input.value);
        input.value = formatted;
        const next = cursorAfterDigits(formatted, digitsBefore);
        input.setSelectionRange(next, next);
    });

    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Backspace') return;
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? start;
        if (start !== end || start === 0) return;
        if (/\d/.test(input.value.charAt(start - 1))) return;

        event.preventDefault();
        const digits = digitsOnly(input.value);
        const digitsBefore = countDigits(input.value.slice(0, start));
        const nextDigits =
            digits.slice(0, Math.max(0, digitsBefore - 1)) + digits.slice(digitsBefore);
        const formatted = format(nextDigits);
        input.value = formatted;
        const next = cursorAfterDigits(formatted, Math.max(0, digitsBefore - 1));
        input.setSelectionRange(next, next);
    });
}

function formatPhone(value) {
    let digits = digitsOnly(value);
    if (digits.startsWith('1')) digits = digits.slice(1);
    digits = digits.slice(0, 10);

    if (digits.length === 0) return '';
    if (digits.length < 4) return `(${digits}`;
    if (digits.length < 7) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function formatZip(value) {
    return digitsOnly(value).slice(0, 5);
}

function digitsOnly(value) {
    return value.replace(/\D/g, '');
}

function countDigits(value) {
    return digitsOnly(value).length;
}

function cursorAfterDigits(formatted, digitCount) {
    if (digitCount <= 0) return 0;
    let seen = 0;
    for (let index = 0; index < formatted.length; index += 1) {
        if (/\d/.test(formatted.charAt(index))) seen += 1;
        if (seen === digitCount) return index + 1;
    }
    return formatted.length;
}
