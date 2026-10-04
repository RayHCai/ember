import markUrl from '../../../assets/brand/icon.svg';

// Imported rather than linked from index.html: a path outside the app root only resolves through the module graph.
export function showBrandMark(): void {
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.type = 'image/svg+xml';
    icon.href = markUrl;
    document.head.append(icon);
    const mark = document.querySelector<HTMLImageElement>('img#mark');
    if (mark) mark.src = markUrl;
}
