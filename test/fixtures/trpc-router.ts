// @ts-nocheck
export const bookingRouter = createTRPCRouter({
  create: publicProcedure.mutation(async () => {}),
  getAll: authedProcedure.query(async () => {}),
})
export const cancelBooking = protectedProcedure.mutation(async () => {})
