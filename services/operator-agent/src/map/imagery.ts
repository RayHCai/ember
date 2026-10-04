import { GoogleGenAI } from '@google/genai';

export type MapImage = { data: Buffer; mimeType: string; generatedBy: string };

type Models = Pick<GoogleGenAI['models'], 'generateContent'>;

/**
 * Gemini's only job in Ember: restyle the planner's map for a phone screen. It receives the
 * deterministic render and must keep its geometry; the render is sent instead whenever Gemini
 * fails or returns no image.
 */
export class GeminiMapImager {
    private readonly models: Models;

    constructor(
        apiKey: string,
        private readonly model: string,
        models?: Models,
    ) {
        this.models = models ?? new GoogleGenAI({ apiKey }).models;
    }

    async stylize(render: Buffer, caption: string): Promise<MapImage> {
        const res = await this.models.generateContent({
            model: this.model,
            contents: [
                {
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType: 'image/png', data: render.toString('base64') } },
                        {
                            text:
                                'Redraw this evacuation map as a clean, high-contrast map graphic that reads well on a phone. ' +
                                'Keep every line, shape, colour meaning, label and position exactly where it is: do not add, move, ' +
                                'remove or rename any road, route, place or fire area, and do not add text. ' +
                                `Context: ${caption}`,
                        },
                    ],
                },
            ],
            config: { responseModalities: ['IMAGE'] },
        });
        const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
        if (!part?.inlineData?.data) throw new Error('gemini returned no image');
        return {
            data: Buffer.from(part.inlineData.data, 'base64'),
            mimeType: part.inlineData.mimeType ?? 'image/png',
            generatedBy: `gemini:${this.model}`,
        };
    }
}
