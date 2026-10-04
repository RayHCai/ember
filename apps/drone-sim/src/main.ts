import { App } from './app';
import type { InjectedLaunch } from './launch';
import { readLaunch } from './launch';

const canvas = document.querySelector<HTMLCanvasElement>('canvas#view');
const status = document.querySelector<HTMLElement>('#status');
const connect = document.querySelector<HTMLFormElement>('form#connect');
const field = document.querySelector<HTMLInputElement>('input#drone');
if (!canvas || !status || !connect || !field)
    throw new Error('index.html must have canvas#view, #status and form#connect with input#drone');

const injected = (window as Window & { emberSimLaunch?: InjectedLaunch }).emberSimLaunch;
const launch = readLaunch(injected, location.search);

if (launch.droneId) {
    void new App(canvas, status, launch).start();
} else {
    connect.hidden = false;
    field.focus();
    // Empty: show the first drone the fleet reports.
    connect.addEventListener(
        'submit',
        (ev) => {
            ev.preventDefault();
            connect.remove();
            const droneId = field.value.trim() || null;
            void new App(canvas, status, { ...launch, droneId }).start();
        },
        { once: true },
    );
}
