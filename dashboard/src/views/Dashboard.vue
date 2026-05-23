<template>
  <AdminLayout
    :baseUrl="apiUrl"
    @logout="logout"
    @refresh="fetchComments(pagination.page)"
  >
    <div v-if="loading" class="flex justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent"></div>
    </div>

    <template v-else>
      <!-- Status filter tabs -->
      <div class="flex items-center space-x-2 mb-4">
        <button v-for="tab in statusTabs" :key="tab.value"
          @click="switchFilter(tab.value)"
          :class="['px-3 py-1.5 text-xs font-medium rounded-lg transition-all',
            currentStatus === tab.value
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50']">
          {{ tab.label }}
        </button>
      </div>

      <CommentList
        :data="tableData"
        :pagination="pagination"
        @page-change="handlePageChange"
        @update="updateStatus"
        @edit="editComment"
      />
    </template>
  </AdminLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import request from '../utils/request';
import toast from '../utils/toast';
import AdminLayout from '../components/AdminLayout.vue';
import CommentList from '../components/CommentList.vue';

const router = useRouter();
const route = useRoute();
const loading = ref(false);
const tableData = ref([]);
const pagination = ref({ page: 1, limit: 10, totalPage: 1 });
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);
const currentStatus = ref('');

const statusTabs = [
  { label: '全部', value: '' },
  { label: '已通过', value: 'approved' },
  { label: '待审核', value: 'pending' },
  { label: '已删除', value: 'deleted' }
];

const fetchComments = async (page = 1) => {
  loading.value = true;
  try {
    const params = { page };
    if (currentStatus.value) {
      params.status = currentStatus.value;
    }
    const res = await request.get('/admin/comments/list', { params });
    if (res.data) {
      tableData.value = res.data.comments || [];
      pagination.value = res.data.pagination || { page: 1, limit: 10, totalPage: 1 };
    }
  } catch (error) {
    toast.error('加载失败');
  } finally {
    loading.value = false;
  }
};

const switchFilter = (status) => {
  currentStatus.value = status;
  pagination.value.page = 1;
  fetchComments(1);
};

const updateStatus = async (id, status) => {
  try {
    await request.put(`/admin/comments/status?id=${id}&status=${status}`);
    toast.success('操作成功');
    fetchComments(pagination.value.page);
  } catch (error) {
    toast.error('更新失败');
  }
};

const editComment = async (payload) => {
  try {
    await request.put('/admin/comments/edit', payload);
    toast.success('修改成功');
    fetchComments(pagination.value.page);
  } catch (error) {
    toast.error('修改失败');
  }
};

const handlePageChange = (p) => fetchComments(p);

const logout = () => {
  localStorage.removeItem('token');
  router.push('/login');
};

onMounted(() => {
  // 从 URL 查询参数读取初始 status 筛选
  const statusParam = route.query.status;
  if (statusParam && ['approved', 'pending', 'deleted'].includes(statusParam)) {
    currentStatus.value = statusParam;
  }
  fetchComments(1);
});
</script>
