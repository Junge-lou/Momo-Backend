<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="loadSettings">
    <div class="max-w-4xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <router-link to="/settings"
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <h1 class="text-2xl font-bold text-gray-800">基本设置</h1>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="saved" class="text-sm text-green-600 font-medium">保存成功</span>
          <button @click="saveSettings" :disabled="loading"
            class="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium">
            {{ loading ? '保存中...' : '保存设置' }}
          </button>
        </div>
      </div>

      <!-- 站点设置 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-globe text-blue-500"></i> 站点信息
        </h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">站点名称</label>
            <input v-model="form.site_name" type="text"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">管理员邮箱</label>
            <input v-model="form.admin_email" type="email"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          </div>
        </div>
      </section>

      <!-- 评论审核 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-check-double text-blue-500"></i> 评论审核
        </h2>
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm font-medium text-gray-700">评论自动通过</p>
            <p class="text-xs text-gray-400 mt-1">开启后新评论无需审核即可显示</p>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="form.comment_auto_approve" class="sr-only peer" true-value="true" false-value="false">
            <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            <span class="ms-3 text-sm font-medium text-gray-700">
              {{ form.comment_auto_approve === 'true' ? '已开启' : '已关闭' }}
            </span>
          </label>
        </div>
        <p class="text-xs text-amber-600 mt-3 flex items-center gap-1">
          <i class="fa-solid fa-triangle-exclamation"></i>
          关闭后，新评论状态为"待审核"，需在评论管理中手动通过
        </p>
      </section>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import request from '../utils/request'
import toast from '../utils/toast'
import AdminLayout from '../components/AdminLayout.vue'

const router = useRouter()
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin)

const loading = ref(false)
const saved = ref(false)

const isDirty = ref(false)
let initialSnapshot = ''

const form = reactive({
  site_name: '',
  admin_email: '',
  comment_auto_approve: 'true',
})

const takeSnapshot = () => JSON.stringify({ ...form })

watch(form, () => {
  isDirty.value = takeSnapshot() !== initialSnapshot
}, { deep: true })

onBeforeRouteLeave((to, from, next) => {
  if (isDirty.value) {
    const answer = window.confirm('有未保存的修改，确定要离开吗？')
    if (!answer) { next(false); return }
  }
  next()
})

const handleBeforeUnload = (e) => {
  if (isDirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', handleBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', handleBeforeUnload))

const loadSettings = async () => {
  try {
    const res = await request.get('/admin/settings')
    if (res.code === 200 && res.data) {
      Object.assign(form, res.data)
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
  initialSnapshot = takeSnapshot()
  isDirty.value = false
}

onMounted(() => {
  loadSettings()
})

const saveSettings = async () => {
  loading.value = true
  saved.value = false
  try {
    const payload = { ...form }
    const res = await request.put('/admin/settings', payload)
    if (res.code === 200) {
      saved.value = true
      toast.success('设置已保存')
      initialSnapshot = takeSnapshot()
      isDirty.value = false
      setTimeout(() => { saved.value = false }, 3000)
    }
  } catch (e) {
    console.error('Failed to save settings:', e)
  } finally {
    loading.value = false
  }
}

const logout = () => {
  localStorage.removeItem('token')
  router.push('/login')
}
</script>
