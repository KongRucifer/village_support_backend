import { PaginationDto, PaginationResponse, PaginatedResult, calculatePagination } from '../dto/pagination.dto.js';

/**
 * Helper to apply pagination to Prisma queries
 */
export function getPrismaPagination(page: number = 1, limit: number = 10) {
  const validPage = Math.max(1, page);
  const validLimit = Math.min(100, Math.max(1, limit));
  const skip = (validPage - 1) * validLimit;

  return {
    skip,
    take: validLimit,
    page: validPage,
    limit: validLimit,
  };
}

/**
 * Create paginated response for Prisma results
 */
export function createPrismaPaginatedResponse<T>(
  results: T[],
  total: number,
  page: number,
  limit: number,
  message: string = 'Fetched successfully',
): PaginatedResult<T> {
  const pagination = calculatePagination(total, page, limit);

  return {
    success: true,
    code: 200,
    message,
    results,
    pagination,
  };
}

/**
 * Interface for paginated Prisma query result
 */
export interface PrismaPaginatedQuery<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Helper to execute paginated Prisma query with count
 */
export async function executePaginatedQuery<T, C>(
  prismaModel: {
    findMany: (args: any) => Promise<T[]>;
    count: (args?: any) => Promise<number>;
  },
  queryArgs: any,
  pagination: { page: number; limit: number },
): Promise<PrismaPaginatedQuery<T>> {
  const { skip, take, page, limit } = getPrismaPagination(pagination.page, pagination.limit);

  const [data, total] = await Promise.all([
    prismaModel.findMany({
      ...queryArgs,
      skip,
      take,
    }),
    prismaModel.count({
      where: queryArgs.where,
    }),
  ]);

  return {
    data,
    total,
    page,
    limit,
  };
}
