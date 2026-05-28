<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick, type Component } from "vue";

export interface ContextMenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
  icon?: Component;
}

const props = defineProps<{
  items: ContextMenuItem[];
}>();

const show = ref(false);
const x = ref(0);
const y = ref(0);
const menuRef = ref<HTMLElement>();

function onContextMenu(event: MouseEvent) {
  if (props.items.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  x.value = event.clientX;
  y.value = event.clientY;
  show.value = true;
  nextTick(() => adjustPosition());
}

function close() {
  show.value = false;
}

function adjustPosition() {
  if (!menuRef.value) return;
  const rect = menuRef.value.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (rect.right > vw) {
    x.value = Math.max(0, vw - rect.width - 8);
  }
  if (rect.bottom > vh) {
    y.value = Math.max(0, vh - rect.height - 8);
  }
}

function onClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    close();
  }
}

function onScroll() {
  close();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

function onResize() {
  close();
}

watch(show, (val) => {
  if (val) {
    document.addEventListener("click", onClickOutside, true);
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
  } else {
    document.removeEventListener("click", onClickOutside, true);
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
  }
});

function handleItemClick(item: ContextMenuItem) {
  if (item.disabled) return;
  close();
  item.action?.();
}

onBeforeUnmount(() => {
  document.removeEventListener("click", onClickOutside, true);
  document.removeEventListener("keydown", onKeydown);
  document.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <slot :on-context-menu="onContextMenu" />
  <Teleport to="body">
    <div
      v-if="show"
      ref="menuRef"
      :style="{ position: 'fixed', left: x + 'px', top: y + 'px', zIndex: 9999 }"
      class="text-popover-foreground min-w-36 rounded-xl p-1 cn-menu-translucent overflow-x-hidden overflow-y-auto"
    >
      <template v-for="(item, index) in items" :key="index">
        <div v-if="item.separator" class="bg-foreground/6 -mx-1 my-0.5 h-px" />
        <button
          v-else
          :disabled="item.disabled"
          class="w-full gap-2 rounded-md px-2 py-1 text-[13px] outline-hidden select-none text-left cursor-default flex items-center hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          @click="handleItemClick(item)"
        >
          <component :is="item.icon" v-if="item.icon" class="size-4 shrink-0" />
          {{ item.label }}
        </button>
      </template>
    </div>
  </Teleport>
</template>
