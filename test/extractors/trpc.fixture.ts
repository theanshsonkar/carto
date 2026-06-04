// Spec 11 fixture — tRPC router with 2 procedures (query + mutation).
import { z } from 'zod';
import { publicProcedure, router } from './trpc';

export const userRouter = router({
  list: publicProcedure.query(() => {
    return [];
  }),
  create: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(({ input }) => {
      return input;
    }),
});
