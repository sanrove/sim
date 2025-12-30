#!/bin/bash

# Multi-Tenant Sim Deployment Script
# This script helps deploy and manage multiple Sim instances for different tenants

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM_ROOT="$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DEFAULT_SHARED_SECRET="test-shared-secret-key-for-sso-development"
DEFAULT_DB_HOST="127.0.0.1"
DEFAULT_DB_USER="postgres"
DEFAULT_DB_PASSWORD="postgres"

function print_header() {
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}========================================${NC}"
}

function print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

function print_error() {
  echo -e "${RED}✗ $1${NC}"
}

function print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

function print_info() {
  echo -e "${BLUE}ℹ $1${NC}"
}

# Check if port is available
function check_port_available() {
  local port=$1
  if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
    return 1
  else
    return 0
  fi
}

# Create database for tenant
function create_tenant_database() {
  local tenant_name=$1
  local db_name="sim_${tenant_name}"
  local db_host=${2:-$DEFAULT_DB_HOST}
  local db_user=${3:-$DEFAULT_DB_USER}
  local db_password=${4:-$DEFAULT_DB_PASSWORD}

  print_info "Creating database: $db_name"

  PGPASSWORD="$db_password" psql -h "$db_host" -U "$db_user" -tc "SELECT 1 FROM pg_database WHERE datname = '$db_name'" | grep -q 1 || \
    PGPASSWORD="$db_password" psql -h "$db_host" -U "$db_user" -c "CREATE DATABASE $db_name"

  if [ $? -eq 0 ]; then
    print_success "Database created: $db_name"
    return 0
  else
    print_error "Failed to create database: $db_name"
    return 1
  fi
}

# Deploy Sim instance in Docker
function deploy_docker_instance() {
  local tenant_id=$1
  local tenant_name=$2
  local port=$3
  local db_name=$4
  local shared_secret=${5:-$DEFAULT_SHARED_SECRET}

  local container_name="sim-${tenant_name}"

  print_info "Deploying Docker container: $container_name"

  # Check if port is available
  if ! check_port_available $port; then
    print_error "Port $port is already in use"
    return 1
  fi

  # Check if container already exists
  if docker ps -a --format '{{.Names}}' | grep -q "^${container_name}$"; then
    print_warning "Container $container_name already exists, removing..."
    docker rm -f "$container_name"
  fi

  # Build image if needed
  if ! docker images --format '{{.Repository}}' | grep -q '^sim$'; then
    print_info "Building Sim Docker image..."
    cd "$SIM_ROOT" && docker build -t sim:latest .
  fi

  # Run container
  docker run -d \
    --name "$container_name" \
    -p "${port}:5863" \
    -e DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5432/${db_name}" \
    -e MODELFLOW_SIM_SHARED_SECRET="$shared_secret" \
    -e NODE_ENV="production" \
    sim:latest

  if [ $? -eq 0 ]; then
    print_success "Container deployed: $container_name on port $port"
    return 0
  else
    print_error "Failed to deploy container: $container_name"
    return 1
  fi
}

# Deploy Sim instance locally
function deploy_local_instance() {
  local tenant_id=$1
  local tenant_name=$2
  local port=$3
  local db_name=$4
  local shared_secret=${5:-$DEFAULT_SHARED_SECRET}

  print_info "Starting local Sim instance for tenant: $tenant_name (port: $port)"

  # Check if port is available
  if ! check_port_available $port; then
    print_error "Port $port is already in use"
    return 1
  fi

  # Start instance in background
  cd "$SIM_ROOT" && \
    PORT=$port \
    DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/${db_name}" \
    MODELFLOW_SIM_SHARED_SECRET="$shared_secret" \
    nohup bun run dev > "logs/sim-${tenant_name}.log" 2>&1 &

  local pid=$!

  if [ $? -eq 0 ]; then
    print_success "Local instance started: $tenant_name (PID: $pid, Port: $port)"
    echo $pid > "pids/sim-${tenant_name}.pid"
    return 0
  else
    print_error "Failed to start local instance: $tenant_name"
    return 1
  fi
}

# List all running instances
function list_instances() {
  print_header "Running Sim Instances"

  echo "Docker Containers:"
  docker ps --filter "name=sim-" --format "table {{.Names}}\t{{.Ports}}\t{{.Status}}" || true

  echo ""
  echo "Local Processes:"
  if [ -d "pids" ]; then
    for pid_file in pids/sim-*.pid; do
      if [ -f "$pid_file" ]; then
        tenant=$(basename "$pid_file" .pid | sed 's/sim-//')
        pid=$(cat "$pid_file")
        if ps -p $pid > /dev/null 2>&1; then
          echo "  $tenant (PID: $pid)"
        fi
      fi
    done
  fi
}

# Stop instance
function stop_instance() {
  local tenant_name=$1
  local method=${2:-all}

  if [ "$method" = "docker" ] || [ "$method" = "all" ]; then
    local container_name="sim-${tenant_name}"
    if docker ps -a --format '{{.Names}}' | grep -q "^${container_name}$"; then
      print_info "Stopping Docker container: $container_name"
      docker stop "$container_name"
      print_success "Container stopped: $container_name"
    fi
  fi

  if [ "$method" = "local" ] || [ "$method" = "all" ]; then
    local pid_file="pids/sim-${tenant_name}.pid"
    if [ -f "$pid_file" ]; then
      local pid=$(cat "$pid_file")
      print_info "Stopping local process: $tenant_name (PID: $pid)"
      kill $pid 2>/dev/null || true
      rm "$pid_file"
      print_success "Process stopped: $tenant_name"
    fi
  fi
}

# Show logs
function show_logs() {
  local tenant_name=$1
  local lines=${2:-50}

  echo "Logs for tenant: $tenant_name (last $lines lines)"
  echo ""

  # Try Docker first
  if docker ps -a --format '{{.Names}}' | grep -q "^sim-${tenant_name}$"; then
    docker logs -n $lines "sim-${tenant_name}"
  # Try local logs
  elif [ -f "logs/sim-${tenant_name}.log" ]; then
    tail -n $lines "logs/sim-${tenant_name}.log"
  else
    print_error "No logs found for tenant: $tenant_name"
  fi
}

# Main menu
function show_menu() {
  echo ""
  echo "Multi-Tenant Sim Management"
  echo "1. Deploy new tenant instance"
  echo "2. List running instances"
  echo "3. Stop instance"
  echo "4. View logs"
  echo "5. Create database"
  echo "6. Exit"
  echo ""
  read -p "Select option: " option
}

# Main function
function main() {
  # Create necessary directories
  mkdir -p logs pids

  if [ $# -eq 0 ]; then
    # Interactive mode
    while true; do
      show_menu
      case $option in
        1)
          read -p "Enter tenant ID: " tenant_id
          read -p "Enter tenant name: " tenant_name
          read -p "Enter port (default 5864): " port
          port=${port:-5864}
          read -p "Use Docker? (y/n, default n): " use_docker

          db_name="sim_${tenant_name}"

          # Create database
          read -p "Create database? (y/n, default y): " create_db
          create_db=${create_db:-y}
          if [ "$create_db" = "y" ]; then
            create_tenant_database "$tenant_name"
          fi

          # Deploy
          if [ "$use_docker" = "y" ]; then
            deploy_docker_instance "$tenant_id" "$tenant_name" "$port" "$db_name"
          else
            deploy_local_instance "$tenant_id" "$tenant_name" "$port" "$db_name"
          fi
          ;;
        2)
          list_instances
          ;;
        3)
          read -p "Enter tenant name to stop: " tenant_name
          read -p "Stop method (docker/local/all, default all): " method
          method=${method:-all}
          stop_instance "$tenant_name" "$method"
          ;;
        4)
          read -p "Enter tenant name to view logs: " tenant_name
          read -p "Number of lines to show (default 50): " lines
          lines=${lines:-50}
          show_logs "$tenant_name" "$lines"
          ;;
        5)
          read -p "Enter tenant name for database: " tenant_name
          create_tenant_database "$tenant_name"
          ;;
        6)
          print_success "Exiting"
          exit 0
          ;;
        *)
          print_error "Invalid option"
          ;;
      esac
    done
  else
    # Command line mode
    case $1 in
      deploy)
        tenant_id=$2
        tenant_name=$3
        port=$4
        db_name="sim_${tenant_name}"
        use_docker=$5

        if [ -z "$tenant_id" ] || [ -z "$tenant_name" ] || [ -z "$port" ]; then
          print_error "Usage: $0 deploy <tenant-id> <tenant-name> <port> [docker|local]"
          exit 1
        fi

        create_tenant_database "$tenant_name"
        if [ "$use_docker" = "docker" ]; then
          deploy_docker_instance "$tenant_id" "$tenant_name" "$port" "$db_name"
        else
          deploy_local_instance "$tenant_id" "$tenant_name" "$port" "$db_name"
        fi
        ;;
      list)
        list_instances
        ;;
      stop)
        if [ -z "$2" ]; then
          print_error "Usage: $0 stop <tenant-name>"
          exit 1
        fi
        stop_instance "$2" "${3:-all}"
        ;;
      logs)
        if [ -z "$2" ]; then
          print_error "Usage: $0 logs <tenant-name> [lines]"
          exit 1
        fi
        show_logs "$2" "${3:-50}"
        ;;
      *)
        print_error "Unknown command: $1"
        echo "Usage:"
        echo "  $0                                    # Interactive mode"
        echo "  $0 deploy <id> <name> <port> [type]  # Deploy new instance"
        echo "  $0 list                               # List running instances"
        echo "  $0 stop <name> [docker|local|all]     # Stop instance"
        echo "  $0 logs <name> [lines]                # View logs"
        exit 1
        ;;
    esac
  fi
}

main "$@"
