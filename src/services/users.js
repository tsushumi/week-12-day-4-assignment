'use strict';

/**
 * Task 2: the N+1 problem and its fix.
 *
 * `tenantId` is optional here: when given, users AND their posts are limited to that tenant.
 * Both versions order by id so they return the same 20 users and can be compared like for like.
 */

// BAD: N+1. One query for the users, then one more query per user for that user's posts.
// 20 users -> 1 + 20 = 21 round trips to the database.
async function getUsersWithPosts(prisma, { tenantId } = {}) {
  // Query 1: get the users
  const users = await prisma.client.findMany({
    ...(tenantId !== undefined && { where: { tenantId } }),
    orderBy: { id: 'asc' },
    take: 20,
  });

  // Queries 2-21: for EACH user, fetch their posts separately
  const results = [];
  for (const user of users) {
    const posts = await prisma.post.findMany({
      where: { authorId: user.id, ...(tenantId !== undefined && { tenantId }) },
    });
    results.push({
      ...user,
      posts,
      postCount: posts.length,
    });
  }

  return results;
}

// GOOD: one query. `include` loads the posts together with the users and `_count` adds the post count.
// relationLoadStrategy: 'join' makes Prisma do it as ONE SQL statement with a LATERAL JOIN; the default
// 'query' strategy would use two statements (users, then all their posts with an IN (...) filter).
async function getUsersWithPostsOptimized(prisma, { tenantId } = {}) {
  return prisma.client.findMany({
    ...(tenantId !== undefined && { where: { tenantId } }),
    orderBy: { id: 'asc' },
    take: 20,
    relationLoadStrategy: 'join',
    include: {
      posts: tenantId !== undefined ? { where: { tenantId } } : true,
      _count: {
        select: { posts: tenantId !== undefined ? { where: { tenantId } } : true },
      },
    },
  });
}

module.exports = { getUsersWithPosts, getUsersWithPostsOptimized };
