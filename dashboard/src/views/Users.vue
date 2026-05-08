<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="fetchUsers(1)">
    <div v-if="loading" class="flex justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent"></div>
    </div>

    <template v-else>
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <!-- Mobile: card layout -->
        <div class="md:hidden divide-y divide-gray-100">
          <div v-for="user in users" :key="user.author + user.email" class="p-4">
            <div class="space-y-3">
              <div class="flex items-start justify-between">
                <div class="flex-1 min-w-0">
                  <span class="font-semibold text-sm block truncate text-gray-800">{{ user.author }}</span>
                  <span class="text-xs block truncate text-gray-400">{{ user.email }}</span>
                </div>
                <button @click="viewUserComments(user)"
                  class="flex-shrink-0 px-3 py-1 text-xs font-medium rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white transition-all">
                  查看评论
                </button>
              </div>
              <div class="border-t pt-3 border-gray-100">
                <div class="flex items-center space-x-3 text-sm">
                  <span class="text-gray-500">共 <strong class="text-blue-600">{{ user.commentCount }}</strong> 条</span>
                  <span v-if="user.approvedCount > 0" class="text-green-600">✓ {{ user.approvedCount }}</span>
                  <span v-if="user.pendingCount > 0" class="text-amber-600">⏳ {{ user.pendingCount }}</span>
                  <span v-if="user.deletedCount > 0" class="text-red-600">✗ {{ user.deletedCount }}</span>
                </div>
              </div>
              <div class="text-[10px] text-gray-400">
                最后评论：{{ formatDate(user.lastCommentDate) }}
              </div>
            </div>
          </div>
          <div v-if="users.length === 0" class="px-5 py-8 text-center text-sm text-gray-400">暂无用户数据</div>
        </div>

        <!-- Desktop: table layout -->
        <div class="hidden md:block overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b bg-gray-50 border-gray-200">
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">作者</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">邮箱</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">评论数</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">已通过</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">待审核</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">已删除</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">最后评论</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-right text-gray-500">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="user in users" :key="user.author + user.email" class="hover:bg-gray-50 transition-colors">
                <td class="px-5 py-3">
                  <span class="text-sm font-medium text-gray-800">{{ user.author }}</span>
                </td>
                <td class="px-5 py-3 text-sm text-gray-500">{{ user.email }}</td>
                <td class="px-5 py-3">
                  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">{{ user.commentCount }}</span>
                </td>
                <td class="px-5 py-3 text-sm text-green-600">{{ user.approvedCount }}</td>
                <td class="px-5 py-3 text-sm text-amber-600">{{ user.pendingCount }}</td>
                <td class="px-5 py-3 text-sm text-red-600">{{ user.deletedCount }}</td>
                <td class="px-5 py-3 text-sm text-gray-500">{{ formatDate(user.lastCommentDate) }}</td>
                <td class="px-5 py-3 text-right">
                  <button @click="viewUserComments(user)"
                    class="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white transition-all">
                    查看评论
                  </button>
                </td>
              </tr>
              <tr v-if="users.length === 0">
                <td colspan="8" class="px-5 py-8 text-center text-sm text-gray-400">暂无用户数据</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="px-5 py-4 border-t flex items-center justify-between bg-gray-50 border-gray-200">
          <span class="text-xs text-gray-500">共 {{ pagination.totalPage }} 页</span>
          <div class="flex items-center space-x-1">
            <button @click="fetchUsers(pagination.page - 1)" :disabled="pagination.page <= 1"
              class="px-3 py-1 text-xs font-medium rounded border disabled:opacity-40 transition-colors border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              上一页
            </button>
            <span class="px-4 text-xs font-bold text-gray-700">{{ pagination.page }}</span>
            <button @click="fetchUsers(pagination.page + 1)" :disabled="pagination.page >= pagination.totalPage"
              class="px-3 py-1 text-xs font-medium rounded border disabled:opacity-40 transition-colors border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              下一页
            </button>
          </div>
        </div>
      </div>
    </template>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import request from '../utils/request';
import toast from '../utils/toast';
import AdminLayout from '../components/AdminLayout.vue';

const router = useRouter();
const loading = ref(false);
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);
const users = ref([]);
const pagination = ref({ page: 1, limit: 20, totalPage: 1 });

const fetchUsers = async (page = 1) => {
  loading.value = true;
  try {
    const res = await request.get('/admin/stats/users', { params: { page, limit: 20 } });
    if (res.data) {
      users.value = res.data.users || [];
      pagination.value = res.data.pagination || { page: 1, limit: 20, totalPage: 1 };
    }
  } catch (error) {
    toast.error('加载用户列表失败');
  } finally {
    loading.value = false;
  }
};

const viewUserComments = (user) => {
  router.push({
    path: '/user-comments',
    query: { author: user.author, email: user.email }
  });
};

const formatDate = (str) => {
  if (!str) return '-';
  return new Date(str).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const logout = () => {
  localStorage.removeItem('token');
  router.push('/login');
};

onMounted(() => fetchUsers(1));
</script>
