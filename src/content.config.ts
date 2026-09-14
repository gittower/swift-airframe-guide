import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const guideCollection = defineCollection({
  loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content/guide' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number().int(),
    subOrder: z.number().int().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = {
  guide: guideCollection,
};
