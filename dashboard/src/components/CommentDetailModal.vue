<template>
  <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" @click="$emit('close')"></div>
    
    <div class="relative bg-white rounded-lg shadow-xl w-full max-w-2xl mx-auto max-h-[85vh] overflow-hidden flex flex-col border border-slate-200">
      
      <div class="sticky top-0 bg-white border-b border-slate-100 px-5 py-4 flex items-center justify-between flex-shrink-0">
        <h3 class="text-sm md:text-base font-semibold text-slate-800 flex items-center tracking-tight">
          <i class="fa-solid fa-message mr-2 text-slate-400"></i>
          评论详情
        </h3>
        <button @click="$emit('close')" class="w-7 h-7 flex items-center justify-center rounded-md hover:bg-slate-100 text-slate-400 transition-colors">
          <i class="fa-solid fa-xmark text-base"></i>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-5 md:p-6 space-y-8 custom-scrollbar">
        
        <section class="space-y-4">
          <div class="flex items-center space-x-3">
            <img v-if="comment.avatar" :src="comment.avatar" class="w-10 h-10 rounded-md object-cover border border-slate-100" alt="avatar" />
            <div class="min-w-0">
              <div class="text-sm font-bold text-slate-900">{{ comment.author }}</div>
              <div class="text-xs text-slate-400 truncate">{{ comment.email || '无邮箱' }}</div>
            </div>
          </div>
          
          <div class="bg-slate-50 rounded-md p-4 border border-slate-100">
            <p class="text-sm text-slate-600 leading-relaxed whitespace-pre-wrap break-words">
              "{{ comment.contentText }}"
            </p>
          </div>
        </section>

        <section class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4 text-sm">
          <div class="border-b border-slate-50 pb-2">
            <span class="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">来源文章</span>
            <span class="text-slate-700 font-medium truncate block text-xs">{{ comment.postSlug || '未知' }}</span>
          </div>
          
          <div class="border-b border-slate-50 pb-2">
            <span class="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">IP 地址</span>
            <span class="text-slate-600 font-mono text-xs">{{ comment.ipAddress || '-' }}</span>
          </div>

          <div class="border-b border-slate-50 pb-2">
            <span class="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">操作系统 / 浏览器</span>
            <span class="text-slate-600 text-xs">{{ comment.os || 'Unknown' }} / {{ comment.browser || 'Unknown' }}</span>
          </div>

          <div class="border-b border-slate-50 pb-2">
            <span class="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">发布时间</span>
            <span class="text-slate-600 text-xs">{{ formatDate(comment.pubDate) }}</span>
          </div>
        </section>

        <section v-if="comment.url || comment.postUrl" class="space-y-2">
          <h4 class="text-[11px] font-bold text-slate-400 uppercase tracking-widest">作者链接</h4>
          <div class="text-xs space-y-1">
             <div v-if="comment.url" class="flex items-center text-blue-500/80 hover:text-blue-600 transition-colors">
               <i class="fa-solid fa-link mr-2 scale-75"></i>
               <a :href="comment.url" target="_blank" rel="noopener noreferrer" class="truncate underline underline-offset-2">{{ comment.url }}</a>
             </div>
             <div v-if="comment.postUrl" class="flex items-center text-slate-500 hover:text-slate-700 transition-colors">
               <i class="fa-solid fa-file-lines mr-2 scale-75"></i>
               <a :href="comment.postUrl" target="_blank" class="truncate">{{ comment.postUrl }}</a>
             </div>
          </div>
        </section>
      </div>

      <div class="sticky bottom-0 bg-slate-50/80 backdrop-blur-md px-5 py-4 border-t border-slate-100 flex-shrink-0">
        <div class="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div class="flex items-center">
            <span :class="statusStyle(comment.status)" class="px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-tighter">
              {{ comment.status }}
            </span>
            <span class="ml-3 text-[11px] font-mono text-slate-400">ID: {{ comment.id }}</span>
          </div>
          
          <div class="flex justify-end space-x-2">
            <button v-if="comment.status !== 'approved'" @click="$emit('update', comment.id, 'approved')" 
              class="w-8 h-8 flex items-center justify-center rounded-lg bg-green-50 text-green-600 hover:bg-green-600 hover:text-white transition-all shadow-sm">
              <i class="fa-solid fa-check text-xs"></i>
            </button>
            <button v-if="comment.status === 'approved'" @click="$emit('update', comment.id, 'pending')" 
              class="w-8 h-8 flex items-center justify-center rounded-lg bg-amber-50 text-amber-600 hover:bg-amber-600 hover:text-white transition-all shadow-sm">
              <i class="fa-solid fa-ban text-xs"></i>
            </button>
            
            <button 
              @click="$emit('delete', comment.id)" 
              :class="comment.status === 'deleted' ? 'opacity-30 cursor-not-allowed bg-gray-100 text-gray-400' : 'bg-red-50 text-red-600 hover:bg-red-600 hover:text-white shadow-sm'"
              class="w-8 h-8 flex items-center justify-center rounded-lg transition-all"
              :disabled="comment.status === 'deleted'">
              <i class="fa-solid fa-trash-can text-xs"></i>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  visible: Boolean,
  comment: {
    type: Object,
    default: () => ({})
  }
});

defineEmits(['close', 'update', 'delete']);

const formatDate = (str) => {
  if (!str) return '未知';
  return new Date(str).toLocaleString('zh-CN', { 
    year: 'numeric',
    month: '2-digit', 
    day: '2-digit', 
    hour: '2-digit', 
    minute: '2-digit' 
  });
};

const statusStyle = (status) => {
  const map = {
    approved: 'bg-green-100 text-green-700',
    pending: 'bg-amber-100 text-amber-700',
    deleted: 'bg-red-100 text-red-700'
  };
  return map[status] || 'bg-gray-100 text-gray-700';
}
</script>

<style scoped>
/* 极简滚动条 */
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}

.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}

.custom-scrollbar::-webkit-scrollbar-thumb {
  background: #e2e8f0; /* slate-200 */
  border-radius: 2px;
}

.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: #cbd5e1; /* slate-300 */
}

/* Firefox */
.custom-scrollbar {
  scrollbar-width: thin;
  scrollbar-color: #e2e8f0 transparent;
}
</style>