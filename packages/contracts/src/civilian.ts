export type Civilian = {
    id: string;
    /** Lowercased. */
    email: string;
    /** US 5-digit ZIP. */
    zipCode: string;
    createdAt: string;
};

export type CreateCivilianRequest = Pick<Civilian, 'email' | 'zipCode'>;
