import { IsOptional, IsInt, Min, Max, IsString, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum SortDirection {
  ASC = 'asc',
  DESC = 'desc',
}

export class PaginationDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, description: 'Page number' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 12, minimum: 1, maximum: 100, description: 'Items per page' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 12;

  @ApiPropertyOptional({ description: 'Search term to filter results' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Field to search in' })
  @IsOptional()
  @IsString()
  searchField?: string;

  @ApiPropertyOptional({ enum: SortDirection, default: SortDirection.DESC, description: 'Sort direction' })
  @IsOptional()
  @IsIn([SortDirection.ASC, SortDirection.DESC])
  sort?: SortDirection = SortDirection.DESC;
}

export interface PaginationResponse {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PaginatedResult<T> {
  success: boolean;
  code: number;
  message: string;
  results: T[];
  pagination: PaginationResponse;
}

export function createPaginatedResponse<T>(
  results: T[],
  pagination: PaginationResponse,
  message: string = 'Fetched successfully',
): PaginatedResult<T> {
  return {
    success: true,
    code: 200,
    message,
    results,
    pagination,
  };
}

export function calculatePagination(total: number, page: number, limit: number): PaginationResponse {
  const totalPages = Math.ceil(total / limit);
  return {
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}
