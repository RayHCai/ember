/** OpenStreetMap Nominatim: one lookup per call, as its usage policy asks, with a real User-Agent. */
export function nominatim(userAgent: string, fetchImpl: typeof fetch = fetch) {
    return async (place: string) => {
        const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: place, format: 'jsonv2', limit: '1' })}`;
        const res = await fetchImpl(url, {
            headers: { 'user-agent': userAgent },
            signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error(`nominatim: ${res.status}`);
        const [hit] = (await res.json()) as { lat: string; lon: string; display_name: string }[];
        return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), label: hit.display_name } : null;
    };
}
