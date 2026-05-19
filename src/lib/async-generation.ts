export interface AsyncGenerationToken {
  isCurrent: () => boolean;
}

export interface AsyncGenerationGuard {
  next: () => AsyncGenerationToken;
  invalidate: () => void;
}

export const createAsyncGenerationGuard = (): AsyncGenerationGuard => {
  let generation = 0;
  return {
    next() {
      generation += 1;
      const mine = generation;
      return {
        isCurrent: () => mine === generation,
      };
    },
    invalidate() {
      generation += 1;
    },
  };
};
