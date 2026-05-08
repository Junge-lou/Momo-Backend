package config

import (
	"os"
	"path/filepath"
	"strconv"

	"gopkg.in/yaml.v3"
)

// Config 结构体对应配置文件字段
type Config struct {
	Port int `yaml:"PORT"`
}

var GlobalConfig *Config

// DefaultConfig 默认配置
func DefaultConfig() *Config {
	return &Config{
		Port: 3000,
	}
}

// LoadConfig 加载或初始化配置文件
func LoadConfig() (*Config, error) {
	configPath := "./config/config.yaml"

	dir := filepath.Dir(configPath)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		os.MkdirAll(dir, 0755)
	}

	// 如果文件不存在，创建并写入默认配置
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		defaultCfg := DefaultConfig()
		data, err := yaml.Marshal(defaultCfg)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(configPath, data, 0644); err != nil {
			return nil, err
		}
		GlobalConfig = defaultCfg
		return defaultCfg, nil
	}

	// 读取现有文件
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, err
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	// PORT 环境变量优先
	if envPort := os.Getenv("PORT"); envPort != "" {
		if p, err := strconv.Atoi(envPort); err == nil {
			cfg.Port = p
		}
	}

	GlobalConfig = &cfg
	return &cfg, nil
}
