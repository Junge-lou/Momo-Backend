import { CommentsModel } from "./prisma"
import { Comment, CreateCommentInput } from "../type/prisma"


class CommentService {
    /*
    * 创建评论
    */
    async createComment(data: CreateCommentInput): Promise<Comment> {
        return await CommentsModel.create({
            data
        });
    }
    /*
    * 获取所有评论，按照最新发布时间排序
    * 支持按状态筛选
    */
    async getAllComments(status?: string): Promise<Comment[]> {
        const where: any = {};
        if (status) {
            where.status = status;
        }
        return await CommentsModel.findMany({
            where,
            orderBy: {
                pub_date: 'desc'
            }
        });
    }
    /*
    * 根据 id 获取评论
    */
    async getCommentById(id: number): Promise<Comment | null> {
        return await CommentsModel.findUnique({
            where: {
                id
            }
        });
    }
    /*
    * 根据文章 slug 获取所有评论
    */
    async getCommentBySlug(postSlug: string): Promise<Comment[] | null> {
        return await CommentsModel.findMany({
            where: {
                post_slug: postSlug,
                status: "approved"
            }
        });
    }
    /*
    * 根据 IP 获取最新的评论
    */
    async getlastCommentByIP(ip: string): Promise<Comment[] | null> {
        return await CommentsModel.findMany({
            where: {
                ip_address: ip
            },
            orderBy: {
                pub_date: 'desc'
            }
        });
    }
    /*
    * 删除评论
    * 这里需要递归删除，将父级下的所有子级都删除
    */
    async deleteComment(id: number) {
        // 先查询所有需要删除的评论ID（包括子孙节点）
        const deleteQueue: number[] = [];
        const queue: number[] = [id];

        while (queue.length > 0) {
            const currentId = queue.shift()!; // 使用非空断言，因为我们确保队列不为空
            deleteQueue.push(currentId);
            const children = await CommentsModel.findMany({
                where: {
                    parent_id: currentId
                }
            });
            // 将所有子评论加入队列
            children.forEach(child => {
                queue.push(child.id);
            });
        }
        /* 并不真实删除，而是改变状态 */
        return await CommentsModel.updateMany({
            where: {
                id: {
                    in: deleteQueue
                }
            },
            data: {
                status: "deleted"
            }
        });
    }
    /*
    * 修改评论状态
    */
    async updateCommentStatus(id: number, status: string): Promise<Comment> {
        return await CommentsModel.update({
            where: {
                id
            },
            data: {
                status
            }
        });
    }
    /*
    * 修改评论内容
    */
    async updateComment(id: number, fields: Record<string, any>): Promise<Comment> {
        const allowed = ['author', 'email', 'content_text', 'content_html', 'url'];
        const data: Record<string, any> = {};
        for (const key of allowed) {
            if (fields[key] !== undefined) {
                data[key] = fields[key];
            }
        }
        return await CommentsModel.update({
            where: { id },
            data
        });
    }
    /*
    * 获取统计概览数据
    */
    async getStatsOverview(range: number = 7) {
        const totalComments = await CommentsModel.count();

        // 统计状态分布
        const statusGroup = await CommentsModel.groupBy({
            by: ['status'],
            _count: true
        });
        const statusDistribution = {
            approved: 0,
            pending: 0,
            deleted: 0
        };
        statusGroup.forEach(g => {
            if (g.status === 'approved') statusDistribution.approved = g._count;
            else if (g.status === 'pending') statusDistribution.pending = g._count;
            else if (g.status === 'deleted') statusDistribution.deleted = g._count;
        });

        // 统计唯一文章数量
        const posts = await CommentsModel.groupBy({
            by: ['post_slug']
        });
        const totalPosts = posts.length;

        // 统计唯一用户数量（author + email 组合）
        const rawUsers: { author: string; email: string }[] = await CommentsModel.findMany({
            select: { author: true, email: true },
            distinct: ['author', 'email']
        });
        const totalUsers = rawUsers.length;

        // 最近 N 天评论趋势（基于 UTC，避免时区偏移导致缺当天数据）
        const now = new Date();
        const recentComments: { date: string; count: number }[] = [];

        if (range === 0) {
            // 最近 12 个月：按月聚合
            const monthlyMap = new Map<string, number>();
            const twelveMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
            const allForTrend = await CommentsModel.findMany({
                where: { pub_date: { gte: twelveMonthsAgo } },
                select: { pub_date: true },
                orderBy: { pub_date: 'asc' }
            });
            // 初始化最近 12 个月
            for (let i = 11; i >= 0; i--) {
                const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
                const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
                monthlyMap.set(key, 0);
            }
            allForTrend.forEach(c => {
                const key = `${c.pub_date.getUTCFullYear()}-${String(c.pub_date.getUTCMonth() + 1).padStart(2, '0')}`;
                if (monthlyMap.has(key)) {
                    monthlyMap.set(key, (monthlyMap.get(key) || 0) + 1);
                }
            });
            Array.from(monthlyMap.entries()).forEach(([date, count]) => {
                recentComments.push({ date, count });
            });
        } else {
            const daysBack = range - 1;
            const dayMap = new Map<string, number>();
            for (let i = daysBack; i >= 0; i--) {
                const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
                dayMap.set(d.toISOString().slice(0, 10), 0);
            }

            const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack));

            const recent = await CommentsModel.findMany({
                where: { pub_date: { gte: startDate } },
                select: { pub_date: true },
                orderBy: { pub_date: 'asc' }
            });

            recent.forEach(c => {
                const key = c.pub_date.toISOString().slice(0, 10);
                if (dayMap.has(key)) {
                    dayMap.set(key, (dayMap.get(key) || 0) + 1);
                }
            });
            Array.from(dayMap.entries()).forEach(([date, count]) => {
                recentComments.push({ date, count });
            });
        }

        // 热门评论者 Top 5
        const commenterMap = new Map<string, { author: string; email: string; count: number; lastCommentDate: Date }>();
        const allForCommenters = await CommentsModel.findMany({
            select: { author: true, email: true, pub_date: true },
            orderBy: { pub_date: 'desc' }
        });
        allForCommenters.forEach(c => {
            const key = `${c.author}|${c.email}`;
            if (commenterMap.has(key)) {
                const existing = commenterMap.get(key)!;
                existing.count++;
            } else {
                commenterMap.set(key, { author: c.author, email: c.email, count: 1, lastCommentDate: c.pub_date });
            }
        });
        const topCommenters = Array.from(commenterMap.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 5)
            .map(c => ({
                author: c.author,
                email: c.email,
                count: c.count,
                lastCommentDate: c.lastCommentDate.toISOString()
            }));

        return { totalComments, totalUsers, totalPosts, statusDistribution, recentComments, topCommenters };
    }

    /*
    * 获取用户列表（按 author + email 分组）
    */
    async getUserList(page: number, limit: number) {
        // 获取所有唯一用户
        const rawUsers: { author: string; email: string }[] = await CommentsModel.findMany({
            select: { author: true, email: true },
            distinct: ['author', 'email'],
            orderBy: { author: 'asc' }
        });

        const total = rawUsers.length;
        const totalPages = Math.ceil(total / limit);
        const startIndex = (page - 1) * limit;
        const pageUsers = rawUsers.slice(startIndex, startIndex + limit);

        const users = await Promise.all(pageUsers.map(async (u) => {
            const comments = await CommentsModel.findMany({
                where: { author: u.author, email: u.email },
                select: { status: true, pub_date: true },
                orderBy: { pub_date: 'desc' }
            });

            const commentCount = comments.length;
            const approvedCount = comments.filter(c => c.status === 'approved').length;
            const pendingCount = comments.filter(c => c.status === 'pending').length;
            const deletedCount = comments.filter(c => c.status === 'deleted').length;
            const firstCommentDate = comments.length > 0 ? comments[comments.length - 1].pub_date.toISOString() : '';
            const lastCommentDate = comments.length > 0 ? comments[0].pub_date.toISOString() : '';

            return { author: u.author, email: u.email, commentCount, approvedCount, pendingCount, deletedCount, firstCommentDate, lastCommentDate };
        }));

        return { users, pagination: { page, limit, totalPage: totalPages } };
    }

    /*
    * 获取指定用户的所有评论
    */
    async getUserComments(author: string, email: string, page: number) {
        const limit = 10;
        const where = { author, email };

        const total = await CommentsModel.count({ where });
        const totalPages = Math.ceil(total / limit);
        const offset = (page - 1) * limit;

        const comments = await CommentsModel.findMany({
            where,
            orderBy: { pub_date: 'desc' },
            skip: offset,
            take: limit
        });

        const formattedComments = comments.map(c => ({
            id: c.id,
            pubDate: c.pub_date.toISOString(),
            postSlug: c.post_slug,
            author: c.author,
            email: c.email,
            url: c.url || undefined,
            ipAddress: c.ip_address || '',
            os: c.os || '',
            browser: c.browser || '',
            contentText: c.content_text,
            contentHtml: c.content_html,
            status: c.status
        }));

        return { comments: formattedComments, pagination: { page, limit, totalPage: totalPages } };
    }
}

export default new CommentService();
