export type Civilian = {
    id: string;
    /** E.164, e.g. +15551234567. */
    phone: string;
    /** US 5-digit ZIP. */
    zipCode: string;
    createdAt: string;
};

export type CreateCivilianRequest = Pick<Civilian, 'phone' | 'zipCode'>;
